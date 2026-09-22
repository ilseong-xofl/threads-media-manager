"""End-to-end pilot tests with synthetic sources and an offline transport."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPTS=Path(__file__).resolve().parents[1]/"local-runtime"
sys.path.insert(0,str(SCRIPTS))
from threads_runner import excel_input,runner
from threads_runner.state import State,StateError,safe_path,file_hash
from threads_runner.transport import TransferError
from test_download_excel import samples,make_book,account_rows


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.root=Path(self.tmp.name).resolve()
        self.data=samples()
        self.data['미디어'][0]['다운로드URL']='https://scontent-test.cdninstagram.com/image.jpg?sig=TEST%2Bvalue'
        self.data['실행기록'][0]['특이사항']=''
        with State(self.root):
            self.saved={'relative_path':'results/2026/09/threads-2026-09-21.xlsx'}
            make_book(self.root/self.saved['relative_path'],self.data)
        self.requests=[]

    def tearDown(self): self.tmp.cleanup()

    def fake(self,url,dest,kind,*,before_request,**kwargs):
        before_request(url,0)
        self.requests.append(url)
        body=b'verified-by-fake-transport'
        dest.write_bytes(body)
        return {'size':len(body),'sha256':hashlib.sha256(body).hexdigest(),'extension':'jpg','width':2,'height':3}

    def plan(self): return runner.plan_one(self.root,'Example')['job_id']

    def test_excel_source_ignores_obsolete_jsonl(self):
        (self.root/self.saved['relative_path']).with_suffix('.jsonl').write_bytes(b'obsolete corrupt ledger')
        result=runner.download_one(self.root,self.plan(),download=self.fake)
        self.assertEqual(result['status'],'complete')
        self.assertEqual(Path(result['path']).read_bytes(),b'verified-by-fake-transport')
        self.assertTrue((self.root/self.saved['relative_path']).exists())
        self.assertEqual(len(self.requests),1)

    def test_duplicate_no_network_and_stable_id(self):
        job=self.plan()
        done=runner.download_one(self.root,job,download=self.fake)
        again=runner.download_one(self.root,job,download=self.fake)
        self.assertEqual(again['status'],'already_complete')
        self.assertEqual(again['path'],done['path'])
        self.assertEqual(len(self.requests),1)
        self.assertFalse((self.root/'_work/collector.lock').exists())

    def test_failure_stop_survives_restart_no_second_request(self):
        def fail(url,dest,kind,*,before_request,**kwargs):
            before_request(url,0);self.requests.append(url)
            raise TransferError('rate_limited','limit',retry_at=9999999999,requires_review=True,status=429)
        job=self.plan()
        with self.assertRaises(TransferError): runner.download_one(self.root,job,download=fail)
        with self.assertRaises(StateError): runner.plan_one(self.root,'Example')
        with self.assertRaises(StateError): runner.download_one(self.root,job,download=self.fake)
        state=runner.status(self.root)
        self.assertEqual(state['requests_24h'],1)
        self.assertEqual(state['stop']['code'],'rate_limited')
        self.assertEqual(state['next_allowed_at'],9999999999)
        self.assertEqual(state['jobs'][0]['http_status'],429)
        self.assertEqual(len(self.requests),1)

    def test_source_changed_before_download_stops_without_request(self):
        job=self.plan()
        p=self.root/self.saved['relative_path'];p.write_bytes(b'broken workbook')
        with self.assertRaises(StateError): runner.download_one(self.root,job,download=self.fake)
        self.assertEqual(self.requests,[])
        self.assertIsNotNone(runner.status(self.root)['stop'])

    def test_request_history_has_no_daily_cap_and_wait_is_after_completion(self):
        job=self.plan();done=runner.download_one(self.root,job,download=self.fake)
        with State(self.root) as state:
            finished=state.db.execute('SELECT updated_at FROM jobs WHERE job_id=?',(job,)).fetchone()[0]
            self.assertGreaterEqual(state.meta('next_allowed')-finished,3)
            self.assertLessEqual(state.meta('next_allowed')-finished,10.1)
            state.clock=lambda: state.meta('next_allowed')+1
            state.reserve_request(job,'hash','scontent-test.cdninstagram.com',0)
            self.assertEqual(state.db.execute('SELECT count(*) FROM requests').fetchone()[0],2)
            with self.assertRaises(StateError) as error: state.reserve_request(job,'hash','scontent-test.cdninstagram.com',1)
            self.assertEqual(error.exception.code,'redirect_limit')

    def test_deleted_completed_file_not_redownloaded(self):
        job=self.plan();done=runner.download_one(self.root,job,download=self.fake)
        Path(done['path']).unlink()
        with self.assertRaises(StateError): runner.download_one(self.root,job,download=self.fake)
        self.assertEqual(len(self.requests),1)
        self.assertEqual(runner.status(self.root)['stop']['code'],'completed_file_changed')

    def test_staged_publish_crash_recovery_has_zero_network(self):
        job=self.plan()
        original=runner._publish
        with patch.object(runner,'_publish',side_effect=OSError('disk temporarily unavailable')):
            with self.assertRaises(OSError): runner.download_one(self.root,job,download=self.fake)
        recovered=runner.recover(self.root)
        self.assertEqual(len(recovered['recovered']),1)
        self.assertEqual(recovered['recovered'][0]['status'],'complete')
        self.assertEqual(len(self.requests),1)
        self.assertIsNotNone(recovered['stop'])

    def test_crash_after_hardlink_before_commit_recovers(self):
        job=self.plan()
        def crash(state,row):
            part=safe_path(state.root,row['part_rel']);final=safe_path(state.root,row['final_rel'])
            final.parent.mkdir(parents=True,exist_ok=True);os.link(part,final)
            raise OSError('crash')
        with patch.object(runner,'_publish',side_effect=crash):
            with self.assertRaises(OSError):runner.download_one(self.root,job,download=self.fake)
        recovered=runner.recover(self.root)
        self.assertEqual(recovered['recovered'][0]['status'],'complete')
        self.assertEqual(len(self.requests),1)

    def test_busy_and_foreign_lock_preserved(self):
        lock=self.root/'_work/collector.lock';lock.write_text('foreign')
        with self.assertRaises(StateError):self.plan()
        self.assertEqual(lock.read_text(),'foreign')

    def test_clock_rollback_and_corrupt_db_preserved(self):
        with State(self.root,clock=lambda:10) as state:
            with self.assertRaises(StateError):state.guard()
            self.assertEqual(state.meta('stop')['code'],'clock_rollback')
        db=self.root/'state/state.db';db.write_bytes(b'corrupt')
        with self.assertRaises(StateError):runner.status(self.root)
        self.assertEqual(db.read_bytes(),b'corrupt')

    def test_symlink_media_refused(self):
        target=self.root/'other';target.mkdir()
        partial=self.root/'media/.partial';partial.rmdir();partial.symlink_to(target,target_is_directory=True)
        with self.assertRaises(StateError):self.plan()




    def test_historical_excel_merges_updated_url_and_complete_caption(self):
        data=copy.deepcopy(self.data)
        for record in data['게시글']+data['미디어']:
            record['확인실행ID']='RunB'
        data['게시글'][0].update({'최근확인시각(KST)':'2026-09-22T12:00:00+09:00','캡션 상태':'partial','캡션':'short'})
        data['미디어'][0].update({'URL확보시각(KST)':'2026-09-22T12:00:00+09:00','다운로드URL':'https://scontent-test.cdninstagram.com/image.jpg?sig=new'})
        data['실행기록'][0].update({'실행ID':'RunB','수집일자(KST)':'2026-09-22','시작(KST)':'2026-09-22T12:00:00+09:00','종료(KST)':'2026-09-22T12:10:00+09:00'})
        make_book(self.root/'results/2026/09/threads-2026-09-22.xlsx',data)
        merged=excel_input.load_collection(self.root)
        self.assertEqual(merged['errors'],[])
        self.assertEqual(len(merged['posts']),1)
        self.assertEqual(merged['posts'][0]['캡션'],self.data['게시글'][0]['캡션'])
        self.assertEqual(merged['media'][0]['다운로드URL'],data['미디어'][0]['다운로드URL'])



    def test_cancel_before_transport_has_no_request(self):
        job=self.plan()
        with self.assertRaises(StateError):runner.download_one(self.root,job,cancel=lambda:True,download=self.fake)
        self.assertEqual(self.requests,[])
        self.assertEqual(runner.status(self.root)['requests_24h'],0)


    def test_cross_account_pending_plan_is_not_returned(self):
        self.plan()
        with self.assertRaises(StateError) as error:runner.plan_one(self.root,'AnotherAccount')
        self.assertEqual(error.exception.code,'pending_other_account')

    def test_windows_drive_relative_paths_rejected_on_all_hosts(self):
        for relative in ('C:escape','D:/escape','file:alternate-stream','../outside'):
            with self.subTest(relative=relative),self.assertRaises(StateError):safe_path(self.root,relative)

    def test_state_never_contains_signed_url_or_caption(self):
        runner.download_one(self.root,self.plan(),download=self.fake)
        with State(self.root) as state:
            dump='\n'.join(state.db.iterdump())
        self.assertNotIn('TEST%2Bvalue',dump)
        self.assertNotIn('First line',dump)


    def test_completed_legacy_job_remains_complete_without_extra_request(self):
        job = self.plan()
        runner.download_one(self.root, job, download=self.fake)
        with State(self.root) as state:
            with state.db:
                state.db.execute("UPDATE jobs SET source_type='jsonl',source_rel='obsolete.jsonl' WHERE job_id=?", (job,))
            request_count = state.db.execute('SELECT COUNT(*) FROM requests').fetchone()[0]
        result = runner.download_one(self.root, job, download=self.fake)
        self.assertEqual(result['status'], 'already_complete')
        self.assertEqual(len(self.requests), 1)
        with State(self.root) as state:
            self.assertEqual(state.db.execute('SELECT COUNT(*) FROM requests').fetchone()[0], request_count)

    def test_pending_legacy_job_blocks_and_does_not_silently_replan(self):
        job = self.plan()
        with State(self.root) as state:
            with state.db:
                state.db.execute("UPDATE jobs SET source_type='jsonl',source_rel='obsolete.jsonl' WHERE job_id=?", (job,))
        with self.assertRaises(StateError):
            runner.download_one(self.root, job, download=self.fake)
        self.assertEqual(self.requests, [])
        with State(self.root) as state:
            self.assertEqual(state.db.execute('SELECT COUNT(*) FROM jobs').fetchone()[0], 1)
            self.assertIsNotNone(state.meta('stop'))


if __name__=='__main__':unittest.main()
