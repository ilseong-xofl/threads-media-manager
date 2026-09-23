"""Excel transaction and recovery behavior; fixtures never contact Threads/CDN."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from test_collection_source import payload, workbook, service, excel_input as excel, SourceError
from threads_source import workbook_write as writer
from collection_journal import append_record


class ExcelCommitTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.input = self.root / '_work/RunA/normalized.json'
        self.journal = self.input.with_name('0001.jsonl')
        self.source = self.root / 'results/2026/09/threads-2026-09-21.xlsx'
        self.accounts = workbook(self.root / 'accounts.xlsx', {'계정': [{'계정명': 'Example', '사용': 'Y', '메모': 'keep', '특이사항': 'user note'}]})
        self.input.parent.mkdir(parents=True)
        self.write(payload())
        for kind in ('start', 'batch', 'end'):
            append_record(self.journal, {'v': 1, 'type': kind, 'run_id': 'RunA', 'account': 'Example', 'event_id': kind, 'payload': {}})

    def tearDown(self):
        self.temp.cleanup()

    def write(self, value):
        self.input.write_text(json.dumps(value, ensure_ascii=False))

    def commit(self, cleanup=False):
        return service.commit_source(self.root, self.input, journal_path=self.journal if cleanup else None)

    def test_success_removes_only_owned_temporaries_after_both_excel_files(self):
        unrelated = self.input.with_name('recovery.jsonl')
        unrelated.write_bytes(b'keep')
        result = self.commit(cleanup=True)
        self.assertTrue(result['temporary_cleaned'])
        self.assertFalse(self.journal.exists())
        self.assertFalse(self.input.exists())
        self.assertEqual(unrelated.read_bytes(), b'keep')
        self.assertEqual(list((self.root/'results').rglob('*.jsonl')), [])
        excel.check_handoff(self.root, 'Example', 'RunA', result['relative_path'])

    def test_accounts_failure_keeps_journal_and_retry_repairs_without_rewriting_source(self):
        original_accounts = self.accounts.read_bytes()
        publish = writer.publish
        def fail(root, relative, *args):
            if relative == 'accounts.xlsx':
                raise OSError('disk full')
            return publish(root, relative, *args)
        with patch.object(writer, 'publish', side_effect=fail), self.assertRaises(OSError):
            self.commit(cleanup=True)
        self.assertEqual(self.accounts.read_bytes(), original_accounts)
        self.assertTrue(self.journal.exists())
        saved = self.source.read_bytes()
        result = self.commit(cleanup=True)
        self.assertFalse(result['appended'])
        self.assertEqual(saved, self.source.read_bytes())
        self.assertEqual(service.inspect_source(self.root)['posts'], 1)
        self.assertFalse(self.journal.exists())

    def test_incomplete_or_wrong_journal_cannot_publish_or_be_deleted(self):
        good = self.journal.read_bytes()
        for content in (good + b'{', good.replace(b'RunA', b'Wrong'), b''):
            self.journal.write_bytes(content)
            with self.assertRaises(SourceError):
                self.commit(cleanup=True)
            self.assertEqual(self.journal.read_bytes(), content)
            self.assertFalse(self.source.exists())

    def test_account_excel_lock_prevents_commit(self):
        marker = self.accounts.with_name('~$accounts.xlsx')
        marker.write_text('open in Excel')
        with self.assertRaises(excel.InputError):
            self.commit(cleanup=True)
        self.assertFalse(self.source.exists())
        self.assertTrue(self.journal.exists())

    def test_replace_failure_preserves_original_excel_and_temporary_journal(self):
        self.commit()
        original = self.source.read_bytes()
        second = payload('RunB')
        for row in second['posts']:
            row['최근확인시각(KST)'] = '2026-09-21T13:00:00+09:00'
        second['media'][0]['URL확보시각(KST)'] = '2026-09-21T13:00:00+09:00'
        second['run']['시작(KST)'] = '2026-09-21T13:00:00+09:00'
        second['run']['종료(KST)'] = '2026-09-21T13:10:00+09:00'
        self.write(second)
        with patch.object(writer.os, 'replace', side_effect=OSError('locked workbook')), self.assertRaises(OSError):
            self.commit()
        self.assertEqual(original, self.source.read_bytes())
        self.assertTrue(self.input.exists())
        self.assertTrue(self.journal.exists())
        self.assertIn(hashlib.sha256(original).hexdigest(), ' '.join(p.name for p in (self.root/'backups/excel').iterdir()))

    def test_repeated_daily_observation_preserves_unknown_columns_notes_and_parts(self):
        self.commit()
        old = excel.read_workbook(self.source)
        row_number = old['posts'][0]['_row']
        annotated = writer.patch_workbook(self.source.read_bytes(), {'게시글': [(row_number, {'사용자 메모': '=literal note'})]})
        self.source.write_bytes(annotated)
        with zipfile.ZipFile(self.source) as book:
            styles = book.read('xl/styles.xml')
        new = payload('RunB')
        new['posts'][0].update({'최근확인시각(KST)': '2026-09-21T13:00:00+09:00', '캡션': '=SUM(1,2)\n=literal'})
        new['media'][0]['URL확보시각(KST)'] = '2026-09-21T13:00:00+09:00'
        new['run'].update({'시작(KST)': '2026-09-21T13:00:00+09:00', '종료(KST)': '2026-09-21T13:10:00+09:00'})
        self.write(new)
        self.commit()
        loaded = excel.read_workbook(self.source)
        self.assertEqual(loaded['errors'], [])
        self.assertEqual(len(loaded['posts']), 1)
        self.assertEqual(len(loaded['runs']), 2)
        self.assertEqual(loaded['posts'][0]['캡션'], '=SUM(1,2)\n=literal')
        extra = excel._read_tables(self.source, {'게시글': (*excel.POST_HEADERS, '사용자 메모')})
        self.assertEqual(extra['게시글'][0]['사용자 메모'], '=literal note')
        with zipfile.ZipFile(self.source) as book:
            self.assertEqual(styles, book.read('xl/styles.xml'))
        account = excel._read_tables(self.accounts, {'계정': excel.ACCOUNT_HEADERS})['계정'][0]
        self.assertEqual(account['메모'], 'keep')
        self.assertEqual(account['특이사항'], 'user note')
        # Replaying an older successful transaction must not rewind account state.
        self.write(payload())
        self.assertFalse(self.commit()['appended'])
        account = excel._read_tables(self.accounts, {'계정': excel.ACCOUNT_HEADERS})['계정'][0]
        self.assertEqual(account['최근실행ID'], 'RunB')

    def test_same_day_new_request_collects_one_new_post_then_zero(self):
        self.commit()
        one_new = payload('RunB')
        one_new['posts'][0].update({'게시글ID': 'New_02', '원문URL': 'https://www.threads.com/@example/post/New_02',
                                    '수집일(KST)': '2026-09-21T13:00:00+09:00',
                                    '최근확인시각(KST)': '2026-09-21T13:00:00+09:00'})
        one_new['media'][0].update({'게시글ID': 'New_02', 'URL확보시각(KST)': '2026-09-21T13:00:00+09:00'})
        one_new['run'].update({'시작(KST)': '2026-09-21T13:00:00+09:00',
                               '종료(KST)': '2026-09-21T13:10:00+09:00', '방식': 'incremental',
                               '기존기준ID': 'AbC_01', '다음기준ID': 'New_02', '최하단확인ID': 'New_02',
                               '기준발견': 'Y', '결과': 'anchor_reached', '누락상태': 'boundary_reached',
                               '이전반영실행ID': 'RunA'})
        self.write(one_new)
        self.commit()
        no_new = payload('RunC')
        no_new['posts'] = []
        no_new['media'] = []
        no_new['run'].update({'시작(KST)': '2026-09-21T13:15:00+09:00',
                              '종료(KST)': '2026-09-21T13:16:00+09:00', '방식': 'incremental',
                              '기존기준ID': 'New_02', '다음기준ID': 'New_02', '최하단확인ID': '',
                              '기준발견': 'Y', '대상확인수': 0, '신규저장수': 0,
                              '결과': 'anchor_reached', '누락상태': 'boundary_reached',
                              '이전반영실행ID': 'RunB'})
        self.write(no_new)
        self.commit()
        loaded = excel.read_workbook(self.source)
        self.assertEqual(loaded['errors'], [])
        self.assertEqual({row['게시글ID'] for row in loaded['posts']}, {'AbC_01', 'New_02'})
        self.assertEqual([row['결과'] for row in loaded['runs']],
                         ['initial_complete', 'anchor_reached', 'anchor_reached'])
        account = service.inspect_source(self.root)['accounts'][0]
        self.assertEqual(account['next_anchor'], 'New_02')
        self.assertEqual(account['last_attempt_run'], 'RunC')

    def test_partial_records_attempt_and_preserves_completed_anchor(self):
        self.commit()
        data = payload('PartialB', '2026-09-22')
        data['run'].update({'결과': 'partial', '기존기준ID': 'AbC_01', '다음기준ID': 'AbC_01', '종료(KST)': None})
        self.write(data)
        self.commit()
        account = service.inspect_source(self.root)['accounts'][0]
        self.assertEqual(account['next_anchor'], 'AbC_01')
        self.assertEqual(account['latest_run'], 'RunA')
        self.assertEqual(account['last_attempt_run'], 'PartialB')
        self.assertEqual(account['last_attempt'], '2026-09-22T12:00:00+09:00')
        self.assertEqual(account['last_result'], 'partial')

    def test_corrupt_excel_is_reported_and_never_replaced(self):
        self.commit()
        self.source.write_bytes(b'damaged')
        self.assertTrue(service.inspect_source(self.root)['errors'])
        with self.assertRaises(SourceError):
            self.commit(cleanup=True)
        self.assertEqual(self.source.read_bytes(), b'damaged')
        self.assertTrue(self.journal.exists())

    def test_changed_input_during_validation_cannot_publish(self):
        original = writer.patch_workbook
        def changed(*args):
            output = original(*args)
            self.input.write_text('{}')
            return output
        with patch.object(writer, 'patch_workbook', side_effect=changed), self.assertRaises(SourceError):
            self.commit(cleanup=True)
        self.assertFalse(self.source.exists())
        self.assertTrue(self.journal.exists())

    def test_conflict_with_older_workbook_is_rejected_before_new_file(self):
        self.commit()
        data = payload('RunB', '2026-09-22')
        data['posts'][0]['이미지 수'] = 2
        extra = dict(data['media'][0], 순서=2)
        data['media'].append(extra)
        self.write(data)
        with self.assertRaises(SourceError):
            self.commit()
        self.assertFalse(self.source.with_name('threads-2026-09-22.xlsx').exists())

    def test_same_day_partial_retains_caption_provenance_and_latest_incomplete_status(self):
        self.commit()
        data = payload('PartialB')
        data['posts'][0].update({'최근확인시각(KST)': '2026-09-21T13:00:00+09:00', '캡션': 'short', '캡션 상태': 'partial', '첨부 상태': 'partial'})
        data['media'][0]['URL확보시각(KST)'] = '2026-09-21T13:00:00+09:00'
        data['run'].update({'시작(KST)': '2026-09-21T13:00:00+09:00', '종료(KST)': None, '결과': 'partial', '기존기준ID': 'AbC_01', '다음기준ID': 'AbC_01'})
        self.write(data)
        self.commit()
        import collection_view
        row = collection_view.read_snapshot(self.root)['snapshot']['posts'][0]
        self.assertEqual(row['caption'], payload()['posts'][0]['캡션'])
        self.assertEqual(row['captionObservedAt'], '2026-09-21T12:00:00+09:00')
        self.assertEqual(row['observedAt'], '2026-09-21T13:00:00+09:00')
        self.assertEqual(row['attachmentStatus'], 'partial')
        self.assertIn('earlier_caption', row['reasons'])
