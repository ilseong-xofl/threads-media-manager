"""Collection source never creates or reads downloader state, media, or network."""
from __future__ import annotations

import contextlib
import copy
import io
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / "plugins/threads-collector/scripts"
sys.path.insert(0, str(SCRIPTS))
import collection_source
from threads_source import excel_input, service
from threads_source.files import CollectionLock, SourceError


def payload(run_id="RunA", day="2026-09-21", account="Example"):
    when = day + "T12:00:00+09:00"
    post = {"계정명": account, "게시글ID": "AbC_01", "원문URL": "https://www.threads.com/@example/post/AbC_01",
            "등록일(KST)": None, "수집일(KST)": when, "최근확인시각(KST)": when,
            "캡션": "first\n두 번째", "이미지 수": 1, "영상 수": 0, "캡션 상태": "complete",
            "첨부 상태": "complete", "확인실행ID": run_id}
    media = {"계정명": account, "게시글ID": "AbC_01", "순서": 1, "종류": "image",
             "다운로드URL": "https://cdn.example.test/a.jpg?sig=a%2FB+123&oe=123",
             "관찰주소": "", "URL확보시각(KST)": when, "만료추정시각(KST)": None,
             "만료근거": "unknown", "주소상태": "http_candidate", "선언 폭(px)": None,
             "선언 높이(px)": None, "추출위치": "img.src", "비고": "", "확인실행ID": run_id}
    run = {"실행ID": run_id, "수집일자(KST)": day, "계정명": account, "시작(KST)": when,
           "종료(KST)": day + "T12:10:00+09:00", "방식": "initial", "기존기준ID": "",
           "다음기준ID": "AbC_01", "최하단확인ID": "AbC_01", "기준발견": "NA",
           "대상확인수": 1, "신규저장수": 1, "결과": "initial_complete",
           "누락상태": "not_applicable", "특이사항": "", "이전반영실행ID": ""}
    return {"posts": [post], "media": [media], "run": run}


def workbook(path, tables):
    namespace = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
    relationship = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    root = ET.Element("workbook", xmlns=namespace, attrib={"xmlns:r": relationship})
    sheets = ET.SubElement(root, "sheets")
    rels = ET.Element("Relationships", xmlns="http://schemas.openxmlformats.org/package/2006/relationships")
    entries = {}
    for index, (name, records) in enumerate(tables.items(), 1):
        headers = excel_input.ACCOUNT_HEADERS if name == "계정" else excel_input.SHEETS[name]
        ET.SubElement(sheets, "sheet", name=name, sheetId=str(index), attrib={"r:id": str(index)})
        ET.SubElement(rels, "Relationship", Id=str(index), Type=relationship + "/worksheet", Target=f"worksheets/sheet{index}.xml")
        data = ET.Element("worksheet", xmlns=namespace)
        sheet_data = ET.SubElement(data, "sheetData")
        rows = {3: ["형식 버전", "daily-v1"], 6: headers}
        rows.update({number: [record.get(header, "") for header in headers] for number, record in enumerate(records, 7)})
        for row_number, values in rows.items():
            row = ET.SubElement(sheet_data, "row", r=str(row_number))
            for column, value in enumerate(values, 1):
                if value is None:
                    continue
                cell = ET.SubElement(row, "c", r=f"{chr(64 + column)}{row_number}", t="inlineStr")
                ET.SubElement(ET.SubElement(cell, "is"), "t").text = str(value)
        entries[f"xl/worksheets/sheet{index}.xml"] = ET.tostring(data)
    entries["xl/workbook.xml"] = ET.tostring(root)
    entries["xl/_rels/workbook.xml.rels"] = ET.tostring(rels)
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return path


class CollectionSourceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.input = self.root / "_work/run/normalized.json"
        self.source = self.root / "results/2026/09/threads-2026-09-21.xlsx"

    def tearDown(self):
        self.temp.cleanup()

    def write_input(self, value=None):
        self.input.parent.mkdir(parents=True, exist_ok=True)
        if not (self.root / "accounts.xlsx").exists():
            workbook(self.root / "accounts.xlsx", {"계정": [{"계정명": "Example", "사용": "Y", "메모": "keep user note"}]})
        self.input.write_text(json.dumps(value if value is not None else payload(), ensure_ascii=False), encoding="utf-8")
        return self.input

    def borrow_lock(self, token="test-token", run_id="RunA", owner="collector"):
        lock = self.root / "_work/collector.lock"
        lock.parent.mkdir(exist_ok=True)
        lock.write_text(json.dumps({"owner": owner, "token": token, "run_id": run_id}), encoding="utf-8")
        return lock

    def legacy(self):
        data = payload()
        source = workbook(self.root / "results/2026/09/threads-2026-09-21.xlsx",
                          {"게시글": data["posts"], "미디어": data["media"], "실행기록": [data["run"]]})
        account = {"사용": "Y", "계정명": "Example", "URL": "https://www.threads.com/@example",
                   "기준게시글ID": "AbC_01", "최근실행ID": "RunA", "최근결과파일": source.relative_to(self.root).as_posix()}
        accounts = workbook(self.root / "accounts.xlsx", {"계정": [account]})
        return source, accounts

    @contextlib.contextmanager
    def forbid_download_storage(self):
        original = os.open
        def guarded(name, *args, **kwargs):
            absolute = Path(name).absolute()
            if self.root / "state" in absolute.parents or self.root / "media" in absolute.parents:
                raise AssertionError("Downloader storage access is forbidden")
            return original(name, *args, **kwargs)
        original_stat = Path.stat
        def guarded_stat(path, *args, **kwargs):
            absolute = path.absolute()
            if any(forbidden == absolute or forbidden in absolute.parents for forbidden in (self.root / "state", self.root / "media")):
                raise AssertionError("Downloader storage metadata access is forbidden")
            return original_stat(path, *args, **kwargs)
        with patch.object(sqlite3, "connect", side_effect=AssertionError("No SQLite allowed")), patch.object(os, "open", side_effect=guarded), patch.object(Path, "stat", guarded_stat):
            yield

    def test_inspect_empty_is_pure_and_creates_no_lock_or_database(self):
        with self.forbid_download_storage():
            result = service.inspect_source(self.root)
        self.assertEqual(result, {"source_files": 0, "posts": 0, "media": 0, "errors": [], "warnings": 0, "accounts": []})
        self.assertEqual(list(self.root.iterdir()), [])

    def test_commit_inspect_and_exact_replay_without_downloader_storage(self):
        self.write_input()
        with self.forbid_download_storage():
            first = service.commit_source(self.root, self.input)
            before = self.source.read_bytes()
            second = service.commit_source(self.root, self.input)
            result = service.inspect_source(self.root)
        self.assertTrue(first["appended"])
        self.assertFalse(second["appended"])
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(result["accounts"][0]["next_anchor"], "AbC_01")
        self.assertEqual((result["posts"], result["media"]), (1, 1))
        self.assertFalse((self.root / "_work/collector.lock").exists())
        self.assertFalse((self.root / "state").exists())
        self.assertFalse((self.root / "media").exists())
        self.assertNotIn("https://", json.dumps(result))
        self.assertEqual(excel_input.load_collection(self.root)["media"][0]["다운로드URL"], payload()["media"][0]["다운로드URL"])

    def test_existing_downloader_storage_is_never_opened_or_modified(self):
        for directory in ("state", "media"):
            (self.root / directory).mkdir()
        database = self.root / "state/state.db"
        marker = self.root / "media/.library.json"
        database.write_bytes(b"not a readable SQLite database")
        marker.write_bytes(b"foreign media library marker")
        self.write_input()
        with self.forbid_download_storage():
            service.commit_source(self.root, self.input)
            service.inspect_source(self.root)
        self.assertEqual(database.read_bytes(), b"not a readable SQLite database")
        self.assertEqual(marker.read_bytes(), b"foreign media library marker")

    def test_inspect_does_not_change_existing_foreign_lock(self):
        self.write_input()
        service.commit_source(self.root, self.input)
        lock = self.borrow_lock(owner="other-app")
        before = lock.read_bytes(), lock.stat().st_mtime_ns
        service.inspect_source(self.root)
        self.assertEqual((lock.read_bytes(), lock.stat().st_mtime_ns), before)

    def test_foreign_lock_blocks_write_and_is_not_removed(self):
        self.write_input()
        lock = self.borrow_lock()
        before = lock.read_bytes()
        with self.assertRaises(SourceError) as caught:
            service.commit_source(self.root, self.input)
        self.assertEqual(caught.exception.code, "busy")
        self.assertEqual(lock.read_bytes(), before)
        self.assertFalse(self.source.exists())

    def test_borrowed_collector_lock_remains_after_success(self):
        self.write_input()
        lock = self.borrow_lock()
        before = lock.read_bytes()
        service.commit_source(self.root, self.input, lock_token="test-token")
        self.assertEqual(lock.read_bytes(), before)
        self.assertTrue(self.source.exists())

    def test_borrow_rejects_wrong_token_owner_and_run_without_mutation(self):
        self.write_input()
        for token, owner, run_id, code in [("wrong", "collector", "RunA", "busy"),
                                           ("test-token", "other", "RunA", "busy"),
                                           ("test-token", "collector", "OtherRun", "run_conflict")]:
            lock = self.borrow_lock(owner=owner, run_id=run_id)
            before = lock.read_bytes()
            with self.assertRaises(SourceError) as caught:
                service.commit_source(self.root, self.input, lock_token=token)
            self.assertEqual(caught.exception.code, code)
            self.assertEqual(lock.read_bytes(), before)
            self.assertFalse(self.source.exists())

    def test_replaced_owned_lock_is_not_deleted(self):
        with CollectionLock(self.root) as owner:
            owner.path.unlink()
            owner.path.write_text('{"owner":"other","token":"foreign"}')
        self.assertEqual(json.loads(owner.path.read_text())["token"], "foreign")

    def test_lock_run_check_repeated_before_commit(self):
        self.write_input()
        lock = self.borrow_lock()
        original = service._check_existing_run
        def replace_after_check(root, run):
            result = original(root, run)
            lock.write_text('{"owner":"collector","token":"replaced","run_id":"RunA"}')
            return result
        with patch.object(service, "_check_existing_run", side_effect=replace_after_check):
            with self.assertRaises(SourceError) as caught:
                service.commit_source(self.root, self.input, lock_token="test-token")
        self.assertEqual(caught.exception.code, "busy")
        self.assertFalse(self.source.exists())
        self.assertEqual(json.loads(lock.read_text())["token"], "replaced")

    def test_conflicting_replay_and_moved_run_day_preserve_source(self):
        self.write_input()
        service.commit_source(self.root, self.input)
        before = self.source.read_bytes()
        changed = payload()
        changed["posts"][0]["캡션"] = "changed"
        self.write_input(changed)
        with self.assertRaises(SourceError) as caught:
            service.commit_source(self.root, self.input)
        self.assertEqual(caught.exception.code, "run_conflict")
        self.assertEqual(self.source.read_bytes(), before)
        self.write_input(payload(day="2026-09-22"))
        with self.assertRaises(SourceError) as caught:
            service.commit_source(self.root, self.input)
        self.assertEqual(caught.exception.code, "run_conflict")
        self.assertFalse((self.source.parent / "threads-2026-09-22.xlsx").exists())

    def test_partial_keeps_previous_anchor_and_exact_missing_end(self):
        self.write_input()
        service.commit_source(self.root, self.input)
        partial = payload(run_id="PartialRun", day="2026-09-22")
        partial["run"].update({"결과": "partial", "종료(KST)": None, "기존기준ID": "AbC_01", "다음기준ID": "AbC_01", "누락상태": "unknown"})
        partial["posts"][0].update({"캡션": "short", "캡션 상태": "partial"})
        self.write_input(partial)
        service.commit_source(self.root, self.input)
        result = service.inspect_source(self.root)
        self.assertEqual(result["accounts"][0]["latest_run"], "RunA")
        self.assertEqual(result["accounts"][0]["next_anchor"], "AbC_01")
        loaded = excel_input.load_collection(self.root)
        self.assertEqual(loaded["posts"][0]["캡션"], payload()["posts"][0]["캡션"])
        self.assertIsNone(next(run for run in loaded["runs"] if run["실행ID"] == "PartialRun")["종료(KST)"])



    def test_invalid_input_json_shapes_and_paths(self):
        self.write_input()
        for text in ('{"posts":[],"posts":[],"media":[],"run":{}}', '{"posts":[],"media":[],"run":NaN}', '{"posts":[],"media":[],"run":[]}'):
            self.input.write_text(text)
            with self.assertRaises(SourceError):
                service.commit_source(self.root, self.input)
            self.assertFalse(self.source.exists())
        outside = self.root / "normalized.json"
        outside.write_text(json.dumps(payload()))
        for target in (outside, Path("_work/normalized.json")):
            with self.assertRaises(SourceError) as caught:
                service.commit_source(self.root, target)
            self.assertEqual(caught.exception.code, "invalid_input")

    def test_symlink_and_hardlink_inputs_are_rejected(self):
        self.write_input()
        link = self.input.parent / "alias.json"
        link.symlink_to(self.input)
        with self.assertRaises(SourceError) as caught:
            service.commit_source(self.root, link)
        self.assertEqual(caught.exception.code, "symlink")
        link.unlink()
        os.link(self.input, link)
        with self.assertRaises(SourceError) as caught:
            service.commit_source(self.root, link)
        self.assertEqual(caught.exception.code, "invalid_file")

    def test_results_symlink_is_not_followed(self):
        destination = self.root / "outside"
        destination.mkdir()
        (self.root / "results").symlink_to(destination, target_is_directory=True)
        with self.assertRaises(SourceError) as caught:
            service.inspect_source(self.root)
        self.assertEqual(caught.exception.code, "symlink")
        self.assertEqual(list(destination.iterdir()), [])



    def test_cli_success_and_safe_failure_do_not_print_source_urls(self):
        self.write_input()
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            code = collection_source.main(["--collection-root", str(self.root), "commit-source", "--input", str(self.input)])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(capture.getvalue())["ok"])
        self.assertNotIn("https://", capture.getvalue())
        self.input.write_text('{"bad":"https://private.example.test/secret"}')
        capture = io.StringIO()
        with contextlib.redirect_stdout(capture):
            code = collection_source.main(["--collection-root", str(self.root), "commit-source", "--input", str(self.input)])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(capture.getvalue())["ok"])
        self.assertNotIn("https://", capture.getvalue())


    def test_state_and_media_symlinks_are_not_even_inspected(self):
        for directory in ("state", "media"):
            (self.root / directory).symlink_to(self.root / "unavailable-outside", target_is_directory=True)
        self.write_input()
        with self.forbid_download_storage():
            service.commit_source(self.root, self.input)
            result = service.inspect_source(self.root)
        self.assertEqual(result["posts"], 1)
        self.assertTrue((self.root / "state").is_symlink())
        self.assertTrue((self.root / "media").is_symlink())


    def test_symlink_year_is_rejected_before_traversal(self):
        results = self.root / "results"
        results.mkdir()
        target = self.root / "other"
        target.mkdir()
        (results / "2026").symlink_to(target, target_is_directory=True)
        with self.assertRaises(SourceError) as caught:
            service.inspect_source(self.root)
        self.assertEqual(caught.exception.code, "symlink")


if __name__ == "__main__":
    unittest.main()
