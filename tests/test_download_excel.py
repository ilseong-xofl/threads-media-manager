"""Daily-v1 import fixtures use invented records and reserved example domains."""
from __future__ import annotations

import copy
import hashlib
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import xml.etree.ElementTree as ET
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / "local-runtime"
sys.path.insert(0, str(SCRIPTS))
from threads_runner import excel_input as excel

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG = "http://schemas.openxmlformats.org/package/2006/relationships"


def _col(number):
    text = ""
    while number:
        number, digit = divmod(number - 1, 26)
        text = chr(65 + digit) + text
    return text


def make_book(path, tables=None, *, date1904=False, overrides=None, extra_parts=None,
              reordered=False, missing_header=None, duplicate_header=False, version="daily-v1"):
    tables = tables if tables is not None else samples()
    wb = ET.Element("workbook", xmlns=NS, attrib={"xmlns:r": REL})
    ET.SubElement(wb, "workbookPr", date1904="1" if date1904 else "0")
    sheets = ET.SubElement(wb, "sheets")
    rels = ET.Element("Relationships", xmlns=PKG)
    shared = ET.Element("sst", xmlns=NS)
    parts = {}
    for idx, (name, records) in enumerate(tables.items(), 1):
        headers = list(excel.ACCOUNT_HEADERS if name == "계정" else excel.SHEETS[name])
        if reordered:
            headers = list(reversed(headers)) + ["사용자 메모"]
        if missing_header:
            headers = [header for header in headers if header != missing_header]
        if duplicate_header:
            headers += [headers[0]]
        ET.SubElement(sheets, "sheet", name=name, sheetId=str(idx), attrib={"r:id": f"rId{idx}"})
        ET.SubElement(rels, "Relationship", Id=f"rId{idx}", Type=REL + "/worksheet", Target=f"worksheets/sheet{idx}.xml")
        sheet = ET.Element("worksheet", xmlns=NS)
        data = ET.SubElement(sheet, "sheetData")
        values = {3: {1: "형식 버전", 2: version}, 6: {i: h for i, h in enumerate(headers, 1)}}
        for row, record in enumerate(records, 7):
            values[row] = {i: record.get(h, "") for i, h in enumerate(headers, 1)}
        for row_num, row_values in values.items():
            row = ET.SubElement(data, "row", r=str(row_num))
            for col, value in row_values.items():
                address = f"{_col(col)}{row_num}"
                value = (overrides or {}).get((name, address), value)
                if value is None:
                    continue
                descriptor = value if isinstance(value, dict) else {"value": value}
                value = descriptor.get("value", "")
                attrib = {"r": address}
                if descriptor.get("date"):
                    attrib["s"] = "1"
                if descriptor.get("custom_date"):
                    attrib["s"] = "2"
                if isinstance(value, (int, float)):
                    cell = ET.SubElement(row, "c", attrib)
                    ET.SubElement(cell, "v").text = str(value)
                elif descriptor.get("shared"):
                    attrib["t"] = "s"
                    cell = ET.SubElement(row, "c", attrib)
                    ET.SubElement(cell, "v").text = str(len(shared))
                    entry = ET.SubElement(shared, "si")
                    if descriptor.get("rich"):
                        for piece in value:
                            ET.SubElement(ET.SubElement(entry, "r"), "t").text = piece
                    else:
                        ET.SubElement(entry, "t").text = value
                else:
                    attrib["t"] = "inlineStr"
                    cell = ET.SubElement(row, "c", attrib)
                    entry = ET.SubElement(cell, "is")
                    if descriptor.get("rich"):
                        for piece in value:
                            ET.SubElement(ET.SubElement(entry, "r"), "t").text = piece
                    else:
                        ET.SubElement(entry, "t").text = str(value)
                if descriptor.get("formula"):
                    ET.SubElement(cell, "f").text = descriptor["formula"]
        parts[f"xl/worksheets/sheet{idx}.xml"] = ET.tostring(sheet)
    ET.SubElement(rels, "Relationship", Id="styles", Type=REL + "/styles", Target="styles.xml")
    ET.SubElement(rels, "Relationship", Id="shared", Type=REL + "/sharedStrings", Target="sharedStrings.xml")
    parts["xl/workbook.xml"] = ET.tostring(wb)
    parts["xl/_rels/workbook.xml.rels"] = ET.tostring(rels)
    parts["xl/sharedStrings.xml"] = ET.tostring(shared)
    parts["xl/styles.xml"] = (f'<styleSheet xmlns="{NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss"/></numFmts><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs></styleSheet>').encode()
    parts.update(extra_parts or {})
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, content in parts.items():
            archive.writestr(name, content)
    return path


def samples(*, day="2026-09-21", run="RunA", account="Example"):
    when = f"{day}T12:00:00+09:00"
    posts = [{
        "계정명": account, "게시글ID": "AbC_01", "원문URL": "https://www.threads.com/@example/post/AbC_01",
        "등록일(KST)": "", "수집일(KST)": when, "최근확인시각(KST)": when, "캡션": "First line\n둘째 줄",
        "이미지 수": 1, "영상 수": 0, "캡션 상태": "complete", "첨부 상태": "complete", "확인실행ID": run,
    }]
    media = [{
        "계정명": account, "게시글ID": "AbC_01", "순서": 1, "종류": "image",
        "다운로드URL": "https://cdn.example.test/media.jpg?oe=abc&sig=A%2Bb%2fC+X&empty=",
        "관찰주소": "https://cdn.example.test/original.jpg?source=dom", "URL확보시각(KST)": when,
        "만료추정시각(KST)": "", "만료근거": "unknown", "주소상태": "http_candidate",
        "선언 폭(px)": "", "선언 높이(px)": "", "추출위치": "img.src", "비고": "", "확인실행ID": run,
    }]
    runs = [{
        "실행ID": run, "수집일자(KST)": day, "계정명": account, "시작(KST)": when,
        "종료(KST)": f"{day}T12:10:00+09:00", "방식": "initial", "기존기준ID": "",
        "다음기준ID": "AbC_01", "최하단확인ID": "AbC_01", "기준발견": "NA", "대상확인수": 1,
        "신규저장수": 1, "결과": "initial_complete", "누락상태": "not_applicable", "특이사항": "", "이전반영실행ID": "",
    }]
    return {"게시글": posts, "미디어": media, "실행기록": runs}


def account_rows(source="results/2026/09/threads-2026-09-21.xlsx", run="RunA", anchor="AbC_01"):
    return {"계정": [{"사용": "Y", "계정명": "Example", "URL": "https://www.threads.com/@example", "기준게시글ID": anchor,
                    "최근실행ID": run, "최근결과파일": source}]}


class ExcelInputTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        # macOS /var is a symlink; use its real test directory explicitly.
        self.root = Path(self.tmp.name).resolve()
        self.path = self.root / "results/2026/09/threads-2026-09-21.xlsx"

    def tearDown(self):
        self.tmp.cleanup()

    def codes(self, result):
        return {error["code"] for error in result["errors"]}

    def test_normal_readonly_header_names_signed_url_and_rich_text(self):
        data = samples()
        data["게시글"][0]["계정명"] = " Example "
        data["게시글"][0]["캡션"] = {"value": ["First\n", "둘째 줄"], "rich": True, "shared": True}
        make_book(self.path, data, reordered=True)
        original = self.path.read_bytes()
        result = excel.read_workbook(self.path)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["posts"][0]["캡션"], "First\n둘째 줄")
        self.assertEqual(result["posts"][0]["계정명"], "Example")
        self.assertEqual(result["posts"][0]["게시글ID"], "AbC_01")
        self.assertEqual(result["media"][0]["다운로드URL"], data["미디어"][0]["다운로드URL"])
        self.assertIsNone(result["posts"][0]["등록일(KST)"])
        self.assertIsNone(result["media"][0]["선언 폭(px)"])
        self.assertFalse(result["media"][0]["_blocked"])
        self.assertEqual(result["source_sha256"], hashlib.sha256(original).hexdigest())
        self.assertEqual(self.path.read_bytes(), original)

    def test_date_epochs_custom_format_and_timezone(self):
        for epoch1904, number in [(False, 61.5), (True, 0.5)]:
            with self.subTest(epoch1904=epoch1904):
                data = samples()
                data["게시글"][0]["등록일(KST)"] = {"value": number, "custom_date": True}
                data["게시글"][0]["최근확인시각(KST)"] = "2026-09-21T03:00:00Z"
                make_book(self.path, data, date1904=epoch1904)
                result = excel.read_workbook(self.path)
                self.assertEqual(result["errors"], [])
                expected = "1904-01-01" if epoch1904 else "1900-03-01"
                self.assertEqual(result["posts"][0]["등록일(KST)"], expected + "T12:00:00+09:00")
                self.assertEqual(result["posts"][0]["최근확인시각(KST)"], "2026-09-21T12:00:00+09:00")
        for value in [{"value": 60, "date": True}, 46000, "09/21/2026"]:
            with self.subTest(invalid=value):
                data = samples()
                data["게시글"][0]["등록일(KST)"] = value
                make_book(self.path, data)
                self.assertIn("invalid_date", self.codes(excel.read_workbook(self.path)))

    def test_formula_cached_value_is_never_used_and_errors_are_safe(self):
        data = samples()
        secret = data["미디어"][0]["다운로드URL"]
        data["미디어"][0]["다운로드URL"] = {"value": secret, "formula": 'HYPERLINK("https://private.invalid/secret")'}
        make_book(self.path, data)
        result = excel.read_workbook(self.path)
        self.assertIn("formula_cell", self.codes(result))
        self.assertIsNone(result["media"][0]["다운로드URL"])
        self.assertTrue(result["media"][0]["_blocked"])
        self.assertNotIn("https://", repr(result["errors"]))

    def test_empty_complete_caption_inline_rich_and_literal_formula_text(self):
        data = samples()
        data["게시글"][0]["캡션"] = ""
        make_book(self.path, data)
        self.assertEqual(excel.read_workbook(self.path)["errors"], [])
        for caption in [{"value": ["A\n", "B"], "rich": True}, "=literal-not-formula"]:
            data["게시글"][0]["캡션"] = caption
            make_book(self.path, data)
            result = excel.read_workbook(self.path)
            self.assertEqual(result["errors"], [])
            self.assertEqual(result["posts"][0]["캡션"], "A\nB" if isinstance(caption, dict) else caption)

    def test_duplicate_identical_once_conflicting_never_downloadable(self):
        data = samples()
        data["미디어"].append(copy.deepcopy(data["미디어"][0]))
        make_book(self.path, data)
        result = excel.read_workbook(self.path)
        self.assertEqual(len(result["media"]), 1)
        self.assertIn("duplicate_identical", {w["code"] for w in result["warnings"]})
        data["미디어"][1]["다운로드URL"] += "&different=true"
        make_book(self.path, data)
        result = excel.read_workbook(self.path)
        self.assertIn("duplicate_conflict", self.codes(result))
        self.assertTrue(all(row["_blocked"] for row in result["media"]))

    def test_running_unknown_orphan_invalid_kind_and_order(self):
        for field, value, code in [("종류", "document", "unknown_media_kind"), ("순서", 0, "invalid_integer"),
                                   ("게시글ID", "NoPost", "orphan_media"), ("확인실행ID", "NoRun", "unknown_run_reference")]:
            data = samples()
            data["미디어"][0][field] = value
            make_book(self.path, data)
            result = excel.read_workbook(self.path)
            self.assertIn(code, self.codes(result))
            self.assertTrue(result["media"][0]["_blocked"])
        for state in ["running", "skipped_daily", "skipped_invalid", "unrecognized"]:
            data = samples()
            data["실행기록"][0]["결과"] = state
            make_book(self.path, data)
            result = excel.read_workbook(self.path)
            self.assertTrue(result["posts"][0]["_blocked"])
            self.assertTrue(result["media"][0]["_blocked"])

    def test_partial_run_without_end_and_blob_missing_are_not_input_errors(self):
        data = samples()
        data["실행기록"][0].update({"결과": "partial", "종료(KST)": "", "누락상태": "unknown"})
        for status in ["missing", "blob_unresolved"]:
            data["미디어"][0].update({"주소상태": status, "다운로드URL": "", "URL확보시각(KST)": ""})
            make_book(self.path, data)
            result = excel.read_workbook(self.path)
            self.assertEqual(result["errors"], [])
            self.assertIsNone(result["runs"][0]["종료(KST)"])
            self.assertFalse(result["posts"][0]["_blocked"])
            self.assertEqual(result["media"][0]["_reasons"], ["direct_url_required"])

    def test_structure_version_headers_and_corrupt_archive(self):
        for kwargs, code in [({"version": "daily-v2"}, "unsupported_format"),
                             ({"missing_header": "확인실행ID"}, "missing_headers"),
                             ({"duplicate_header": True}, "invalid_headers")]:
            make_book(self.path, **kwargs)
            with self.assertRaises(excel.InputError) as caught:
                excel.read_workbook(self.path)
            self.assertEqual(caught.exception.code, code)
        self.path.write_bytes(b"not a workbook")
        with self.assertRaises(excel.InputError) as caught:
            excel.read_workbook(self.path)
        self.assertEqual(caught.exception.code, "invalid_workbook")

    def test_archive_traversal_xml_entities_limits(self):
        for parts, code in [({"../outside.xml": b"x"}, "unsafe_archive"),
                            ({"xl/workbook.xml": b'<!DOCTYPE workbook [<!ENTITY x "abc">]><workbook>&x;</workbook>'}, "unsafe_xml")]:
            make_book(self.path, extra_parts=parts)
            with self.assertRaises(excel.InputError) as caught:
                excel.read_workbook(self.path)
            self.assertEqual(caught.exception.code, code)
        make_book(self.path)
        with patch.object(excel, "MAX_ARCHIVE_BYTES", 10):
            with self.assertRaises(excel.InputError) as caught:
                excel.read_workbook(self.path)
            self.assertEqual(caught.exception.code, "input_limit")
        with patch.object(excel, "MAX_EXPANDED_BYTES", 10):
            with self.assertRaises(excel.InputError) as caught:
                excel.read_workbook(self.path)
            self.assertEqual(caught.exception.code, "input_limit")

    def test_source_changed_while_parsing_fails_closed(self):
        make_book(self.path)
        original = excel._table
        changed = False
        def replace_after_parse(*args, **kwargs):
            nonlocal changed
            result = original(*args, **kwargs)
            if not changed:
                changed = True
                data = samples()
                data["게시글"][0]["캡션"] = "new content"
                make_book(self.path, data)
            return result
        with patch.object(excel, "_table", side_effect=replace_after_parse):
            with self.assertRaises(excel.InputError) as caught:
                excel.read_workbook(self.path)
        self.assertEqual(caught.exception.code, "source_changed")

    def test_discovery_exact_paths_and_symlinks(self):
        make_book(self.path)
        make_book(self.root / "results/2026/09/renamed.xlsx")
        make_book(self.root / "results/2026/08/threads-2026-09-21.xlsx")
        make_book(self.root / "backups/2026/09/threads-2026-09-20.xlsx")
        link = self.path.parent / "threads-2026-09-20.xlsx"
        link.symlink_to(self.path)
        with self.assertRaises(excel.InputError):
            excel.discover_workbooks(self.root)
        with self.assertRaises(excel.InputError) as caught:
            excel.read_workbook(link)
        self.assertEqual(caught.exception.code, "symlink")

    def test_collection_preserves_latest_complete_caption_earliest_date_gap(self):
        older = samples(day="2026-09-20", run="OldRun")
        older["실행기록"][0].update({"결과": "cap_reached", "누락상태": "possible_gap"})
        make_book(self.root / "results/2026/09/threads-2026-09-20.xlsx", older)
        newer = samples()
        newer["게시글"][0].update({"캡션": "Truncated", "캡션 상태": "partial"})
        newer["미디어"][0]["다운로드URL"] += "&updated=1"
        make_book(self.path, newer)
        bad = self.path.parent / "threads-2026-09-19.xlsx"
        bad.write_bytes(b"corrupt")
        result = excel.load_collection(self.root)
        self.assertEqual(len(result["posts"]), 1)
        self.assertEqual(len(result["media"]), 1)
        self.assertEqual(result["posts"][0]["캡션"], older["게시글"][0]["캡션"])
        self.assertEqual(result["posts"][0]["캡션 상태"], "complete")
        self.assertEqual(result["posts"][0]["수집일(KST)"], older["게시글"][0]["수집일(KST)"])
        self.assertEqual(result["media"][0]["다운로드URL"], newer["미디어"][0]["다운로드URL"])
        self.assertIn("possible_gap", {warning["code"] for warning in result["warnings"]})
        self.assertIn("invalid_workbook", self.codes(result))
        self.assertEqual(result["sources"][1]["relative_path"], "results/2026/09/threads-2026-09-21.xlsx")

    def test_same_observation_conflict_and_media_kind_changes_are_blocked(self):
        old = samples(day="2026-09-20", run="OldRun")
        new = samples()
        old["게시글"][0]["최근확인시각(KST)"] = new["게시글"][0]["최근확인시각(KST)"]
        old["게시글"][0]["캡션"] = "conflicting at exact same time"
        new["미디어"][0]["종류"] = "video"
        make_book(self.root / "results/2026/09/threads-2026-09-20.xlsx", old)
        make_book(self.path, new)
        result = excel.load_collection(self.root)
        self.assertIn("observation_conflict", self.codes(result))
        self.assertIn("media_kind_conflict", self.codes(result))
        self.assertTrue(result["media"][0]["_blocked"])

    def test_numeric_ids_rejected_but_case_preserved(self):
        data = samples()
        data["게시글"][0]["게시글ID"] = 100
        make_book(self.path, data)
        result = excel.read_workbook(self.path)
        self.assertIn("invalid_id", self.codes(result))
        self.assertIsNone(result["posts"][0]["게시글ID"])

    def test_handoff_checks_committed_account_and_keeps_all_bytes(self):
        make_book(self.path)
        accounts = make_book(self.root / "accounts.xlsx", account_rows())
        before = {path: path.read_bytes() for path in (self.path, accounts)}
        source = self.path.relative_to(self.root).as_posix()
        excel.check_handoff(self.root, "Example", "RunA", source)
        for path, content in before.items():
            self.assertEqual(path.read_bytes(), content)
        make_book(accounts, account_rows(anchor="older_anchor"))
        with self.assertRaises(excel.InputError) as caught:
            excel.check_handoff(self.root, "Example", "RunA", source)
        self.assertEqual(caught.exception.code, "handoff_not_committed")
        with self.assertRaises(excel.InputError):
            excel.check_handoff(self.root, "Example", "RunA", "../outside.xlsx")

    def test_normalized_records_validate_without_file_access_or_mutation(self):
        data = samples()
        before = copy.deepcopy(data)
        with patch.object(excel, "_read_stable", side_effect=AssertionError("No file read expected")):
            result = excel.validate_records(data["게시글"], data["미디어"], data["실행기록"])
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["media"][0]["다운로드URL"], data["미디어"][0]["다운로드URL"])
        self.assertEqual(result["runs"][0]["수집일자(KST)"], "2026-09-21T00:00:00+09:00")
        self.assertEqual(data, before)
        data["미디어"][0]["확인실행ID"] = "unknown"
        result = excel.validate_records(data["게시글"], data["미디어"], data["실행기록"])
        self.assertIn("unknown_run_reference", self.codes(result))


    def test_pure_merge_keeps_complete_caption_and_sources_without_reading(self):
        old = samples(day="2026-09-20", run="OldRun")
        new = samples()
        new["게시글"][0].update({"캡션": "partial", "캡션 상태": "partial"})
        validated = [excel.validate_records(data["게시글"], data["미디어"], data["실행기록"]) for data in (old, new)]
        for index, result in enumerate(validated):
            for kind in ("posts", "media", "runs"):
                for row in result[kind]:
                    row["_source"] = f"ledger/run-{index}.jsonl"
                    row["_source_sha256"] = str(index) * 64
        before = copy.deepcopy(validated)
        with patch.object(excel, "_read_stable", side_effect=AssertionError("No file read expected")):
            result = excel.merge_validated_sources(validated)
        self.assertEqual(result["errors"], [])
        self.assertEqual(result["posts"][0]["캡션"], old["게시글"][0]["캡션"])
        self.assertEqual(result["posts"][0]["_source"], "ledger/run-1.jsonl")
        self.assertEqual(result["posts"][0]["_caption_source"], "ledger/run-0.jsonl")
        self.assertEqual(validated, before)
        reversed_result = excel.merge_validated_sources(list(reversed(validated)))
        self.assertEqual(result, reversed_result)

    def test_complete_counts_and_observed_order_changes_block_download(self):
        data = samples()
        data["게시글"][0]["이미지 수"] = 2
        result = excel.validate_records(data["게시글"], data["미디어"], data["실행기록"])
        self.assertIn("attachment_count_mismatch", self.codes(result))
        self.assertTrue(result["media"][0]["_blocked"])
        old = samples(day="2026-09-20", run="OldRun")
        new = samples()
        for current in (old, new):
            current["게시글"][0]["이미지 수"] = 2
            second = copy.deepcopy(current["미디어"][0])
            second.update({"순서": 2, "다운로드URL": "https://cdn.example.test/second.jpg"})
            current["미디어"].append(second)
        new["미디어"][0]["다운로드URL"], new["미디어"][1]["다운로드URL"] = new["미디어"][1]["다운로드URL"], new["미디어"][0]["다운로드URL"]
        sources = [excel.validate_records(current["게시글"], current["미디어"], current["실행기록"]) for current in (old, new)]
        result = excel.merge_validated_sources(sources)
        self.assertIn("media_order_conflict", self.codes(result))
        self.assertTrue(all(row["_blocked"] for row in result["media"]))


if __name__ == "__main__":
    unittest.main()
