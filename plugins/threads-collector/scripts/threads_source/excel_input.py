"""Read-only, bounded daily-v1 Excel source adapter (Python 3.11 stdlib).

Limits: 64 MiB compressed file, 128 MiB expanded archive, 32 MiB per XML
part, 1,000 ZIP entries, 100,000 data rows per sheet, 10,000 workbooks per
collection, 500,000 collection records, and 1,000,000 cells/shared strings. Unknown formats are rejected.
File/structure failures raise InputError; load_collection isolates those failures
per file. Logical row failures remain visible as blocked records plus safe
structured errors. Empty optional values stay empty/None; dates become ISO KST.
Only ISO YYYY-MM-DD and YYYY-MM-DD[T ]HH:MM[:SS[.ffffff]][Z|+/-HH:MM]
strings are accepted. Excel numeric dates require a date-formatted cell; the
nonexistent 1900-02-29 (serial 60) is rejected. No formulas are evaluated.
"""
from __future__ import annotations

import copy
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import re
import stat
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_EVEN
import zipfile
import xml.etree.ElementTree as ET

MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
MAX_EXPANDED_BYTES = 128 * 1024 * 1024
MAX_XML_BYTES = 32 * 1024 * 1024
MAX_ZIP_ENTRIES = 1000
MAX_ROWS = 100_000
MAX_CELLS = 1_000_000
MAX_WORKBOOKS = 10_000
MAX_COLLECTION_RECORDS = 500_000
KST = timezone(timedelta(hours=9))

POST_HEADERS = (
    "계정명", "게시글ID", "원문URL", "등록일(KST)", "수집일(KST)",
    "최근확인시각(KST)", "캡션", "이미지 수", "영상 수", "캡션 상태", "첨부 상태", "확인실행ID",
)
MEDIA_HEADERS = (
    "계정명", "게시글ID", "순서", "종류", "다운로드URL", "관찰주소", "URL확보시각(KST)",
    "만료추정시각(KST)", "만료근거", "주소상태", "선언 폭(px)", "선언 높이(px)",
    "추출위치", "비고", "확인실행ID",
)
RUN_HEADERS = (
    "실행ID", "수집일자(KST)", "계정명", "시작(KST)", "종료(KST)", "방식", "기존기준ID",
    "다음기준ID", "최하단확인ID", "기준발견", "대상확인수", "신규저장수", "결과", "누락상태",
    "특이사항", "이전반영실행ID",
)
ACCOUNT_HEADERS = (
    "사용", "계정명", "URL", "메모", "기준게시글ID", "최근 시도(KST)", "최근 완료(KST)",
    "최근 결과", "특이사항", "최근실행ID", "최근결과파일",
)
SHEETS = {"게시글": POST_HEADERS, "미디어": MEDIA_HEADERS, "실행기록": RUN_HEADERS}
COMMITTED = {"initial_complete", "anchor_reached", "cap_reached", "end_reached", "partial"}
RUN_STATES = COMMITTED | {"running", "skipped_daily", "skipped_invalid"}
DATE_FIELDS = {header for headers in (*SHEETS.values(), ACCOUNT_HEADERS) for header in headers if "(KST)" in header} | {"캡션원본확인시각(KST)"}
STRING_IDS = {"게시글ID", "실행ID", "확인실행ID", "기존기준ID", "다음기준ID", "최하단확인ID", "이전반영실행ID", "기준게시글ID", "최근실행ID", "캡션원본실행ID"}
DATE_RE = re.compile(r"\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})?)?\Z")
SOURCE_RE = re.compile(r"results/(\d{4})/(\d{2})/threads-(\d{4}-\d{2}-\d{2})\.xlsx\Z")
CELL_RE = re.compile(r"([A-Z]{1,3})([1-9]\d*)\Z")


class InputError(ValueError):
    """Error with a stable public code; messages never include cell values/URLs."""
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)


def _fail(code: str, message: str):
    raise InputError(code, message)


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _children(node, name):
    return [child for child in node if _local(child.tag) == name]


def _child(node, name):
    return next((child for child in node if _local(child.tag) == name), None)


def _signature(value):
    return value.st_dev, value.st_ino, value.st_size, value.st_mtime_ns, value.st_ctime_ns


def _no_symlinks(path: Path):
    # Check existing components without resolving away a symbolic link first.
    for part in [path, *path.parents]:
        if part.is_symlink():
            _fail("symlink", "Symbolic links are not accepted as collection input.")


def _read_stable(path: Path) -> bytes:
    path = Path(os.path.abspath(path))
    try:
        _no_symlinks(path)
        before = path.stat()
        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            _fail("not_regular_file", "Workbook input must be a regular file.")
        if before.st_size > MAX_ARCHIVE_BYTES:
            _fail("input_limit", "Workbook exceeds the compressed input limit.")
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            opened = os.fstat(stream.fileno())
            if _signature(before) != _signature(opened):
                _fail("source_changed", "Workbook changed while opening it.")
            data = stream.read(MAX_ARCHIVE_BYTES + 1)
            after_read = os.fstat(stream.fileno())
        _no_symlinks(path)
        after = path.stat()
        if len(data) > MAX_ARCHIVE_BYTES:
            _fail("input_limit", "Workbook exceeds the compressed input limit.")
        if _signature(before) != _signature(after_read) or _signature(before) != _signature(after) or len(data) != before.st_size:
            _fail("source_changed", "Workbook changed while reading it.")
        return data
    except InputError:
        raise
    except OSError:
        _fail("input_unavailable", "Workbook could not be read safely.")


def _rich_text(node) -> str:
    # Phonetic rPh annotations are not part of the displayed caption.
    parts = []
    for child in node:
        if _local(child.tag) == "t":
            parts.append(child.text or "")
        elif _local(child.tag) == "r":
            parts.extend(t.text or "" for t in child if _local(t.tag) == "t")
    return "".join(parts)


def _date_format(code: str) -> bool:
    clean = re.sub(r'"[^"]*"|\\.|_.|\*.', "", code)
    clean = re.sub(r"\[(?![hms]+\])[^]]*\]", "", clean, flags=re.I)
    return bool(re.search(r"[ymdhs]", clean, re.I))


class _Workbook:
    def __init__(self, data: bytes):
        try:
            self.archive = zipfile.ZipFile(io.BytesIO(data))
            entries = self.archive.infolist()
            if len(entries) > MAX_ZIP_ENTRIES:
                _fail("input_limit", "Workbook has too many archive parts.")
            names = set()
            expanded = 0
            for info in entries:
                name = info.filename
                parts = PurePosixPath(name).parts
                if not name or name.startswith("/") or "\\" in name or ":" in name or ".." in parts or "\x00" in name:
                    _fail("unsafe_archive", "Workbook contains an unsafe archive path.")
                if name in names:
                    _fail("unsafe_archive", "Workbook contains duplicate archive parts.")
                names.add(name)
                if stat.S_ISLNK(info.external_attr >> 16) or info.flag_bits & 1:
                    _fail("unsafe_archive", "Workbook contains a forbidden archive entry.")
                if info.compress_type not in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}:
                    _fail("unsafe_archive", "Workbook uses unsupported archive compression.")
                expanded += info.file_size
                if expanded > MAX_EXPANDED_BYTES or (info.file_size > 1024 * 1024 and info.file_size > max(info.compress_size, 1) * 1000):
                    _fail("input_limit", "Workbook exceeds the expanded input limit.")
            self.names = names
            workbook = self.xml("xl/workbook.xml")
            props = _child(workbook, "workbookPr")
            self.date1904 = props is not None and props.get("date1904", "0").lower() in {"1", "true"}
            self.relationships = {}
            for rel in self.xml("xl/_rels/workbook.xml.rels"):
                if _local(rel.tag) != "Relationship":
                    continue
                ident, target = rel.get("Id"), rel.get("Target", "")
                if ident in self.relationships:
                    _fail("invalid_workbook", "Workbook contains duplicate relationship IDs.")
                if rel.get("TargetMode") == "External":
                    continue  # Hyperlinks are never fetched; external sheets cannot resolve.
                if "\\" in target or ":" in target or ".." in PurePosixPath(target).parts:
                    _fail("unsafe_archive", "Workbook relationship has an unsafe target.")
                resolved = target.lstrip("/") if target.startswith("/") else "xl/" + target
                self.relationships[ident] = (resolved, rel.get("Type", "").rsplit("/", 1)[-1])
            self.sheets = {}
            sheet_nodes = _child(workbook, "sheets")
            if sheet_nodes is None:
                _fail("invalid_workbook", "Workbook has no sheet directory.")
            for sheet in sheet_nodes:
                name = sheet.get("name")
                ident = next((value for key, value in sheet.attrib.items() if _local(key) == "id"), None)
                if name in self.sheets:
                    _fail("invalid_workbook", "Workbook contains duplicate sheet names.")
                target, kind = self.relationships.get(ident, (None, None))
                if kind != "worksheet" or target not in self.names:
                    _fail("invalid_workbook", "Workbook sheet relationship cannot be resolved.")
                self.sheets[name] = target
            self.strings = []
            shared = [target for target, kind in self.relationships.values() if kind == "sharedStrings"]
            if len(shared) > 1:
                _fail("invalid_workbook", "Workbook contains multiple shared string tables.")
            if shared:
                for entry in self.xml(shared[0]):
                    if _local(entry.tag) == "si":
                        self.strings.append(_rich_text(entry))
                    if len(self.strings) > MAX_CELLS:
                        _fail("input_limit", "Workbook has too many shared strings.")
            self.date_styles = set()
            style_parts = [target for target, kind in self.relationships.values() if kind == "styles"]
            if len(style_parts) > 1:
                _fail("invalid_workbook", "Workbook contains multiple style tables.")
            if style_parts:
                styles = self.xml(style_parts[0])
                custom = {int(n.get("numFmtId")): n.get("formatCode", "") for group in _children(styles, "numFmts") for n in group}
                builtins = set(range(14, 23)) | set(range(27, 37)) | set(range(45, 48)) | set(range(50, 59))
                xfs = _child(styles, "cellXfs")
                if xfs is not None:
                    for index, xf in enumerate(xfs):
                        fmt = int(xf.get("numFmtId", "0"))
                        if fmt in builtins or (fmt in custom and _date_format(custom[fmt])):
                            self.date_styles.add(index)
        except InputError:
            raise
        except (zipfile.BadZipFile, KeyError, ET.ParseError, ValueError, TypeError, IndexError, RuntimeError, OSError):
            _fail("invalid_workbook", "Workbook package is malformed or unsupported.")

    def xml(self, name):
        try:
            info = self.archive.getinfo(name)
            if info.file_size > MAX_XML_BYTES:
                _fail("input_limit", "Workbook XML part exceeds the input limit.")
            data = self.archive.read(info)
            if b"\x00" in data or re.search(br"<!\s*(?:DOCTYPE|ENTITY)\b", data, re.I):
                _fail("unsafe_xml", "Workbook XML declarations are not accepted.")
            return ET.fromstring(data)
        except InputError:
            raise
        except (zipfile.BadZipFile, KeyError, ET.ParseError, RuntimeError, OSError):
            _fail("invalid_workbook", "Workbook XML part is missing or malformed.")

    def rows(self, sheet):
        if sheet not in self.sheets:
            _fail("missing_sheet", "Workbook is missing a required sheet.")
        root = self.xml(self.sheets[sheet])
        sheet_data = _child(root, "sheetData")
        rows = {}
        cell_count = 0
        if sheet_data is None:
            _fail("invalid_workbook", "Workbook sheet has no cell data.")
        for row in sheet_data:
            try:
                number = int(row.get("r", "0"))
            except ValueError:
                _fail("invalid_workbook", "Workbook has an invalid row address.")
            if not 1 <= number <= MAX_ROWS + 6:
                _fail("input_limit", "Workbook row number exceeds the supported limit.")
            if number in rows:
                _fail("invalid_workbook", "Workbook contains duplicate row addresses.")
            cells = {}
            for cell in row:
                if _local(cell.tag) != "c":
                    continue
                cell_count += 1
                if cell_count > MAX_CELLS:
                    _fail("input_limit", "Workbook has too many cells.")
                address = CELL_RE.fullmatch(cell.get("r", ""))
                if not address or int(address[2]) != number:
                    _fail("invalid_workbook", "Workbook has an invalid cell address.")
                col = 0
                for char in address[1]:
                    col = col * 26 + ord(char) - 64
                if col > 16384 or col in cells:
                    _fail("invalid_workbook", "Workbook has an invalid or duplicate cell address.")
                value = _child(cell, "v")
                raw = value.text if value is not None and value.text is not None else ""
                typ = cell.get("t", "n")
                try:
                    style = int(cell.get("s", "0"))
                    if typ == "s":
                        idx = int(raw)
                        if idx < 0:
                            raise ValueError()
                        raw = self.strings[idx]
                    elif typ == "inlineStr":
                        inline = _child(cell, "is")
                        raw = _rich_text(inline) if inline is not None else ""
                    elif typ not in {"n", "str", "b", "e", "d"}:
                        raise ValueError()
                except (ValueError, IndexError):
                    _fail("invalid_workbook", "Workbook contains an invalid cell encoding.")
                cells[col] = {"value": raw, "type": typ, "date": style in self.date_styles, "formula": _child(cell, "f") is not None}
            rows[number] = cells
        return rows


def _date(cell, epoch1904, date_only=False):
    raw = cell["value"]
    if raw == "":
        return None
    try:
        if cell["type"] == "n":
            if not cell["date"]:
                raise ValueError()
            value = Decimal(raw)
            if not value.is_finite() or value < (0 if epoch1904 else 1) or (not epoch1904 and 60 <= value < 61):
                raise ValueError()
            epoch = datetime(1904, 1, 1, tzinfo=KST) if epoch1904 else datetime(1899, 12, 30 if value >= 61 else 31, tzinfo=KST)
            micros = int((value * 86400 * 1_000_000).to_integral_value(rounding=ROUND_HALF_EVEN))
            result = epoch + timedelta(microseconds=micros)
        elif cell["type"] in {"s", "inlineStr", "str", "d"} and DATE_RE.fullmatch(raw):
            result = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            result = result.replace(tzinfo=KST) if result.tzinfo is None else result.astimezone(KST)
        else:
            raise ValueError()
        if date_only and (result.hour or result.minute or result.second or result.microsecond):
            raise ValueError()
        return result.isoformat()
    except (ValueError, OverflowError, InvalidOperation):
        _fail("invalid_date", "Date cell must contain an unambiguous supported date.")


def _issue(result, code, sheet, row, message, warning=False):
    result["warnings" if warning else "errors"].append({"code": code, "sheet": sheet, "row": row, "message": message})


def _block(record, code):
    record["_blocked"] = True
    if code not in record["_reasons"]:
        record["_reasons"].append(code)


def _row_error(result, record, code, sheet, message):
    already_reported = code in record["_reasons"]
    _block(record, code)
    if not already_reported:
        _issue(result, code, sheet, record["_row"], message)


def _empty_cell():
    return {"value": "", "type": "inlineStr", "date": False, "formula": False}


def _table(book, sheet, headers, result):
    rows = book.rows(sheet)
    version = rows.get(3, {})
    if any(version.get(i, _empty_cell())["formula"] for i in (1, 2)) or version.get(1, _empty_cell())["value"] != "형식 버전" or version.get(2, _empty_cell())["value"] != "daily-v1":
        _fail("unsupported_format", "Required daily-v1 sheet version marker is missing.")
    named = {}
    for col, cell in rows.get(6, {}).items():
        value = cell["value"].strip()
        if value:
            if cell["formula"] or value in named:
                _fail("invalid_headers", "Workbook has a formula or duplicate header.")
            named[value] = col
    if any(header not in named for header in headers):
        _fail("missing_headers", "Workbook is missing required contract headers.")
    records = []
    for number, cells in sorted(rows.items()):
        if number < 7:
            continue
        if not any(cells.get(named[h], _empty_cell())["value"] != "" or cells.get(named[h], _empty_cell())["formula"] for h in headers):
            continue
        record = {"_row": number, "_blocked": False, "_reasons": []}
        for header in headers:
            cell = cells.get(named[header], _empty_cell())
            value = cell["value"]
            record[header] = value
            if cell["formula"]:
                record[header] = None  # Cached results are not trusted, even for identifiers.
                _row_error(result, record, "formula_cell", sheet, "A contract field contains a formula.")
                continue
            if cell["type"] == "e":
                record[header] = None
                _row_error(result, record, "cell_error", sheet, "A contract field contains an Excel error.")
                continue
            if header in DATE_FIELDS:
                try:
                    record[header] = _date(cell, book.date1904, header == "수집일자(KST)")
                except InputError as exc:
                    record[header] = None
                    _row_error(result, record, exc.code, sheet, str(exc))
            elif header in STRING_IDS and value != "" and cell["type"] not in {"s", "inlineStr", "str"}:
                record[header] = None
                _row_error(result, record, "invalid_id", sheet, "Identifiers must be literal strings.")
            elif header == "계정명":
                record[header] = value.strip()
                if value and cell["type"] not in {"s", "inlineStr", "str"}:
                    _row_error(result, record, "invalid_account", sheet, "Account names must be literal strings.")
            elif header in {"순서", "이미지 수", "영상 수", "선언 폭(px)", "선언 높이(px)", "대상확인수", "신규저장수"}:
                if value == "":
                    record[header] = None
                else:
                    try:
                        parsed = Decimal(value)
                        minimum = 1 if header in {"순서", "선언 폭(px)", "선언 높이(px)"} else 0
                        if not parsed.is_finite() or parsed != parsed.to_integral_value() or not minimum <= parsed <= 2**31 - 1:
                            raise ValueError()
                        record[header] = int(parsed)
                    except (ValueError, InvalidOperation):
                        record[header] = None
                        _row_error(result, record, "invalid_integer", sheet, "A count, order, or dimension is invalid.")
        records.append(record)
    return records


def _key(row, kind):
    fields = ("계정명", "실행ID") if kind == "runs" else ("계정명", "게시글ID", "순서") if kind == "media" else ("계정명", "게시글ID")
    values = tuple(row.get(field) for field in fields)
    return values if all(value is not None and value != "" for value in values) else None


def _content(row):
    return {key: value for key, value in row.items() if not key.startswith("_")}


def _deduplicate(rows, kind, sheet, result):
    groups, output = {}, []
    for row in rows:
        key = _key(row, kind)
        if key is None:
            output.append(row)
            continue
        previous = groups.setdefault(key, [])
        identical = next((old for old in previous if _content(old) == _content(row) and old["_reasons"] == row["_reasons"]), None)
        if identical is not None:
            _issue(result, "duplicate_identical", sheet, row["_row"], "Identical duplicate row was used once.", True)
            continue
        if previous:
            for old in [*previous, row]:
                _block(old, "duplicate_conflict")
            _issue(result, "duplicate_conflict", sheet, row["_row"], "Rows with the same logical key conflict.")
        previous.append(row)
        output.append(row)
    return output


def _validate(result):
    for kind, sheet in (("posts", "게시글"), ("media", "미디어"), ("runs", "실행기록")):
        required = ["계정명", "실행ID", "수집일자(KST)", "시작(KST)"] if kind == "runs" else ["계정명", "게시글ID", "확인실행ID"]
        if kind == "posts":
            required += ["원문URL", "수집일(KST)", "최근확인시각(KST)"]
        if kind == "media":
            required.append("순서")
        for row in result[kind]:
            if any(row.get(field) in {None, ""} for field in required):
                _row_error(result, row, "missing_required", sheet, "A required identifier, reference, or observation value is missing.")
            if kind == "runs":
                if row["결과"] not in RUN_STATES:
                    _row_error(result, row, "unknown_run_state", sheet, "Collection run has an unknown result state.")
                elif row["결과"] in {"running", "skipped_daily", "skipped_invalid"}:
                    _block(row, "run_" + row["결과"])
                if row["방식"] not in {"initial", "incremental"} or row["기준발견"] not in {"Y", "N", "NA"} or row["누락상태"] not in {"not_applicable", "boundary_reached", "possible_gap", "unknown"}:
                    _row_error(result, row, "invalid_run_value", sheet, "Collection run contains an unsupported state value.")
                if row["결과"] in COMMITTED - {"partial"} and not row["종료(KST)"]:
                    _row_error(result, row, "missing_run_end", sheet, "A completed collection run needs its actual end time.")
                if row.get("시작(KST)") and row.get("종료(KST)") and row["종료(KST)"] < row["시작(KST)"]:
                    _row_error(result, row, "invalid_time_order", sheet, "Collection end precedes collection start.")
                if row["누락상태"] == "possible_gap" or row["결과"] == "partial":
                    _issue(result, "possible_gap" if row["누락상태"] == "possible_gap" else "partial_collection", sheet, row["_row"], "Collection warning is retained from its original run.", True)
            elif kind == "posts":
                if row["캡션 상태"] not in {"complete", "partial", "unknown"} or row["첨부 상태"] not in {"complete", "partial", "unknown"}:
                    _row_error(result, row, "invalid_completeness", sheet, "Post has an unknown completeness state.")
                if row.get("수집일(KST)") and row.get("최근확인시각(KST)") and row["최근확인시각(KST)"] < row["수집일(KST)"]:
                    _row_error(result, row, "invalid_time_order", sheet, "Last observation precedes first collection time.")
            else:
                if row["종류"] not in {"image", "video"}:
                    _row_error(result, row, "unknown_media_kind", sheet, "Media kind is unsupported.")
                if row["주소상태"] == "http_candidate":
                    if not isinstance(row["다운로드URL"], str) or not row["다운로드URL"].startswith("https://") or not row["URL확보시각(KST)"]:
                        _row_error(result, row, "invalid_candidate", sheet, "An HTTPS candidate and its actual observation time are required.")
                elif row["주소상태"] in {"blob_unresolved", "missing"}:
                    _block(row, "direct_url_required")
                else:
                    _row_error(result, row, "unknown_address_state", sheet, "Media address state is unsupported.")
        result[kind] = _deduplicate(result[kind], kind, sheet, result)
    _references(result)


def _references(result):
    runs = {}
    for row in result["runs"]:
        runs.setdefault(_key(row, "runs"), []).append(row)
    posts = {}
    for row in result["posts"]:
        posts.setdefault(_key(row, "posts"), []).append(row)
    media_by_post = {}
    for row in result["media"]:
        media_by_post.setdefault((row.get("계정명"), row.get("게시글ID")), []).append(row)
    for key, post_rows in posts.items():
        attachments = media_by_post.get(key, [])
        orders = {row.get("순서") for row in attachments}
        for post in post_rows:
            counts = (post.get("이미지 수"), post.get("영상 수"))
            if post.get("첨부 상태") == "complete" and all(isinstance(count, int) for count in counts):
                total = sum(counts)
                if len(orders) != total or (orders and (None in orders or min(orders) != 1 or max(orders) != total)):
                    _row_error(result, post, "attachment_count_mismatch", "게시글", "Complete attachment counts and observed orders disagree.")
    for kind, sheet in (("posts", "게시글"), ("media", "미디어")):
        for row in result[kind]:
            match = runs.get((row.get("계정명"), row.get("확인실행ID")), [])
            if not match:
                _row_error(result, row, "unknown_run_reference", sheet, "Observation does not reference a known account run.")
            elif len(match) != 1 or match[0]["_blocked"]:
                _row_error(result, row, "uncommitted_run", sheet, "Observation references an uncommitted or invalid account run.")
            if kind == "media":
                parent = posts.get((row.get("계정명"), row.get("게시글ID")), [])
                if not parent:
                    _row_error(result, row, "orphan_media", sheet, "Media has no matching post.")
                elif any(post["_blocked"] for post in parent):
                    _row_error(result, row, "blocked_post", sheet, "Media belongs to an invalid or ambiguous post.")


def _read_tables(path, table_headers):
    path = Path(path)
    for name in ('~$' + path.name, '.~lock.' + path.name + '#'):
        marker = path.with_name(name)
        if marker.exists() or marker.is_symlink():
            _fail("excel_busy", "Excel에서 파일을 닫은 뒤 다시 실행하세요.")
    data = _read_stable(path)
    book = _Workbook(data)
    result = {"source_sha256": hashlib.sha256(data).hexdigest(), "errors": [], "warnings": []}
    try:
        for sheet, headers in table_headers.items():
            result[sheet] = _table(book, sheet, headers, result)
    finally:
        book.archive.close()
    # Detect an atomic replacement made while XML parsing took place as well.
    if hashlib.sha256(_read_stable(Path(path))).hexdigest() != result["source_sha256"]:
        _fail("source_changed", "Workbook changed while parsing it.")
    return result


def read_workbook(path: Path) -> dict:
    """Read one daily-v1 workbook without modifying it or fetching any URL."""
    raw = _read_tables(path, SHEETS)
    result = {"source_sha256": raw["source_sha256"], "posts": raw["게시글"], "media": raw["미디어"], "runs": raw["실행기록"], "errors": raw["errors"], "warnings": raw["warnings"]}
    # Optional provenance for a same-day partial refresh that retained a prior
    # complete caption/count. This stays inside the sole Excel source.
    provenance_bytes = _read_stable(path)
    if hashlib.sha256(provenance_bytes).hexdigest() != result["source_sha256"]:
        _fail("source_changed", "Workbook changed while reading provenance.")
    book = _Workbook(provenance_bytes)
    try:
        named = {cell["value"] for cell in book.rows("게시글").get(6, {}).values()}
    finally:
        book.archive.close()
    optional = [h for h in ("캡션원본확인시각(KST)", "캡션원본실행ID", "최근관찰첨부 상태") if h in named]
    if optional:
        extra = _read_tables(path, {"게시글": (*POST_HEADERS, *optional)})
        if extra["source_sha256"] != result["source_sha256"]:
            _fail("source_changed", "Workbook changed while reading provenance.")
        result["errors"].extend(extra["errors"])
        by_row = {r["_row"]: r for r in extra["게시글"]}
        for row in result["posts"]:
            values = by_row[row["_row"]]
            for column, key in (("캡션원본확인시각(KST)", "_caption_time"), ("캡션원본실행ID", "_caption_run"), ("최근관찰첨부 상태", "_latest_attachment_status")):
                if values.get(column):
                    row[key] = values[column]
            if row.get("_caption_time") and (not row.get("_caption_run") or row["_caption_time"] > (row.get("최근확인시각(KST)") or "")):
                _row_error(result, row, "invalid_provenance", "게시글", "Caption provenance must identify an earlier observation.")
            if row.get("_latest_attachment_status", "partial") not in {"complete", "partial", "unknown"}:
                _row_error(result, row, "invalid_state", "게시글", "Invalid observed attachment state.")
    _validate(result)
    run_keys = {(run.get("계정명"), run.get("실행ID")) for run in result["runs"]}
    for row in result["posts"]:
        if row.get("_caption_run") and (row["계정명"], row["_caption_run"]) not in run_keys:
            _row_error(result, row, "invalid_provenance", "게시글", "Caption observation run is missing.")
    return result



def validate_records(posts: list[dict], media: list[dict], runs: list[dict]) -> dict:
    """Normalize/validate canonical Korean-column records without file access.

    Dates must use supported ISO strings; numeric timestamps have no Excel style
    and are rejected. Unknown extra columns are ignored. Input is never mutated.
    A missing optional value becomes the same empty value as in a workbook.
    """
    records_by_sheet = {"게시글": posts, "미디어": media, "실행기록": runs}

    class RecordsBook:
        date1904 = False

        def rows(self, sheet):
            records = records_by_sheet[sheet]
            if not isinstance(records, list) or len(records) > MAX_ROWS:
                _fail("input_limit", "Normalized record input exceeds the supported limit.")
            headers = SHEETS[sheet]
            rows = {
                3: {1: dict(_empty_cell(), value="형식 버전"), 2: dict(_empty_cell(), value="daily-v1")},
                6: {i: dict(_empty_cell(), value=h) for i, h in enumerate(headers, 1)},
            }
            for index, record in enumerate(records, 7):
                if not isinstance(record, dict):
                    _fail("invalid_records", "Normalized input must contain record objects.")
                cells = {}
                for col, header in enumerate(headers, 1):
                    value = record.get(header)
                    if value is not None and not isinstance(value, (str, int, float, bool)):
                        _fail("invalid_records", "Normalized contract values must be scalar values.")
                    typ = "inlineStr" if value is None or isinstance(value, str) else "b" if isinstance(value, bool) else "n"
                    cells[col] = dict(_empty_cell(), value="" if value is None else str(value), type=typ)
                rows[index] = cells
            return rows

    result = {"posts": [], "media": [], "runs": [], "errors": [], "warnings": []}
    book = RecordsBook()
    for kind, sheet in (("posts", "게시글"), ("media", "미디어"), ("runs", "실행기록")):
        result[kind] = _table(book, sheet, SHEETS[sheet], result)
    _validate(result)
    return result


def _source_date(relative):
    match = SOURCE_RE.fullmatch(relative)
    if not match:
        _fail("invalid_source_path", "Source must use the daily results path contract.")
    try:
        date = datetime.strptime(match[3], "%Y-%m-%d").date()
    except ValueError:
        _fail("invalid_source_path", "Source path has an invalid calendar date.")
    if match[1] != f"{date.year:04}" or match[2] != f"{date.month:02}":
        _fail("invalid_source_path", "Source date does not match its year/month folders.")
    return date.isoformat()


def discover_workbooks(collection_root: Path) -> list[Path]:
    """Discover only results/YYYY/MM/threads-YYYY-MM-DD.xlsx, no symlinks."""
    root = Path(os.path.abspath(collection_root))
    _no_symlinks(root)
    if not root.is_dir():
        _fail("collection_unavailable", "Collection root is not an available directory.")
    results = root / "results"
    if results.is_symlink():
        _fail("symlink", "Results directory must not be a symbolic link.")
    if not results.exists():
        return []
    if not results.is_dir():
        _fail("collection_unavailable", "Results path is not a directory.")
    found = []
    try:
        for year in sorted(results.iterdir()):
            if re.fullmatch(r"\d{4}", year.name) and year.is_symlink():
                _fail("symlink", "Source year must not be a symbolic link.")
            if not re.fullmatch(r"\d{4}", year.name) or year.is_symlink() or not year.is_dir():
                continue
            for month in sorted(year.iterdir()):
                if re.fullmatch(r"\d{2}", month.name) and month.is_symlink():
                    _fail("symlink", "Source month must not be a symbolic link.")
                if not re.fullmatch(r"\d{2}", month.name) or month.is_symlink() or not month.is_dir():
                    continue
                for path in sorted(month.iterdir()):
                    if path.is_symlink() and SOURCE_RE.fullmatch(path.relative_to(root).as_posix()):
                        _fail("symlink", "Source workbook must not be a symbolic link.")
                    if path.is_symlink() or not path.is_file():
                        continue
                    relative = path.relative_to(root).as_posix()
                    if not SOURCE_RE.fullmatch(relative):
                        continue
                    try:
                        _source_date(relative)
                    except InputError:
                        continue
                    found.append(path)
                    if len(found) > MAX_WORKBOOKS:
                        _fail("input_limit", "Collection has too many daily workbooks.")
    except OSError:
        _fail("collection_unavailable", "Collection directories could not be read safely.")
    return found


def _observed(row, kind, run_times):
    if kind == "posts":
        return row.get("최근확인시각(KST)") or ""
    if kind == "runs":
        return row.get("시작(KST)") or ""
    return row.get("URL확보시각(KST)") or run_times.get((row.get("계정명"), row.get("확인실행ID")), "")


def _merge(rows, kind, result, run_times):
    groups, invalid = {}, []
    sheet = {"posts": "게시글", "media": "미디어", "runs": "실행기록"}[kind]
    for row in rows:
        key = _key(row, kind)
        if key is None:
            invalid.append(row)
        else:
            groups.setdefault(key, []).append(row)
    merged = []
    for key in sorted(groups):
        observations = sorted(groups[key], key=lambda row: (_observed(row, kind, run_times), row["_source"], row["_row"]))
        chosen = copy.deepcopy(observations[-1])
        # Preserve all corruption conflicts instead of silently using a later row.
        if any("duplicate_conflict" in row["_reasons"] for row in observations):
            _block(chosen, "duplicate_conflict")
        same_time = [row for row in observations if _observed(row, kind, run_times) == _observed(chosen, kind, run_times)]
        if len({_fingerprint(row, kind) for row in same_time}) > 1:
            _row_error(result, chosen, "observation_conflict", sheet, "The same logical key and observation time contain conflicting values.")
        if kind == "runs" and len({_fingerprint(row, kind) for row in observations}) > 1:
            _row_error(result, chosen, "run_conflict", sheet, "The same account run differs across source files.")
        if kind == "posts":
            collected = [row["수집일(KST)"] for row in observations if row.get("수집일(KST)")]
            if collected:
                chosen["수집일(KST)"] = min(collected)
            for status, fields in (("캡션 상태", ["캡션"]), ("첨부 상태", ["이미지 수", "영상 수"])):
                complete = [row for row in observations if row.get(status) == "complete" and not row["_blocked"]]
                if chosen.get(status) != "complete" and complete:
                    for field in [status, *fields]:
                        chosen[field] = complete[-1][field]
                    chosen["_caption_source" if status == "캡션 상태" else "_attachment_source"] = complete[-1]["_source"]
            complete_counts = {(row.get("이미지 수"), row.get("영상 수")) for row in observations if row.get("첨부 상태") == "complete"}
            if len(complete_counts) > 1:
                _row_error(result, chosen, "attachment_conflict", sheet, "Complete observations disagree on attachment counts.")
        if kind == "media":
            if len({row.get("종류") for row in observations}) > 1:
                _row_error(result, chosen, "media_kind_conflict", sheet, "An attachment key changed media kind.")
        merged.append(chosen)
    return merged + invalid


def _fingerprint(row, kind):
    values = _content(row)
    # A repeated observation on a later daily file has a different first-in-file
    # collection time; it is still the same observation rather than a conflict.
    if kind == "posts":
        values.pop("수집일(KST)", None)
    return repr(sorted(values.items()))


def load_collection(root: Path) -> dict:
    """Read and deterministically merge a collection; bad files stay isolated."""
    root = Path(os.path.abspath(root))
    result = {"sources": [], "posts": [], "media": [], "runs": [], "errors": [], "warnings": []}
    for path in discover_workbooks(root):
        relative = path.relative_to(root).as_posix()
        try:
            current = read_workbook(path)
        except InputError as exc:
            result["errors"].append({"code": exc.code, "sheet": None, "row": None, "message": str(exc), "source": relative})
            continue
        result["sources"].append({"relative_path": relative, "sha256": current["source_sha256"]})
        date = _source_date(relative)
        for run in current["runs"]:
            if run.get("수집일자(KST)") and run["수집일자(KST)"][:10] != date:
                _row_error(current, run, "run_date_mismatch", "실행기록", "Run date disagrees with its daily source filename.")
        for kind in ("posts", "media", "runs"):
            for row in current[kind]:
                row["_source"] = relative
                row["_source_sha256"] = current["source_sha256"]
            result[kind].extend(current[kind])
        for kind in ("errors", "warnings"):
            result[kind].extend(dict(issue, source=relative) for issue in current[kind])
        if sum(len(result[kind]) for kind in ("posts", "media", "runs")) > MAX_COLLECTION_RECORDS:
            _fail("input_limit", "Collection exceeds the total record limit.")
    return _merge_result(result)


def _merge_result(result):
    original_media = result["media"]
    run_times = {}
    for row in result["runs"]:
        key = (row.get("계정명"), row.get("실행ID"))
        run_times[key] = max(run_times.get(key, ""), row.get("시작(KST)") or "")
    for kind in ("runs", "posts", "media"):
        result[kind] = _merge(result[kind], kind, result, run_times)
    _references(result)
    # Reusing the identical observed address at a different order is evidence
    # of an unresolved ordering change; signed-address changes alone are normal.
    addresses = {}
    for row in original_media:
        address = row.get("다운로드URL")
        if address:
            snapshots = addresses.setdefault((row.get("계정명"), row.get("게시글ID"), address), {})
            snapshots.setdefault((row["_source"], row.get("확인실행ID")), set()).add(row.get("순서"))
    conflicting_keys = set()
    for (account, post, _), snapshots in addresses.items():
        if len({frozenset(orders) for orders in snapshots.values()}) > 1:
            conflicting_keys.update((account, post, order) for orders in snapshots.values() for order in orders)
    for row in result["media"]:
        if _key(row, "media") in conflicting_keys:
            _row_error(result, row, "media_order_conflict", "미디어", "An observed media address changed attachment order across observations.")
    return result


def merge_validated_sources(sources: list[dict]) -> dict:
    """Pure merge of read_workbook/validate_records outputs; inputs stay intact.

    Callers attach _source and _source_sha256 to validated rows. Missing source
    metadata gets a deterministic local label and an empty hash (never a made-up
    digest). This performs no filesystem access and does not validate raw rows;
    raw input must first pass validate_records. Existing warnings/errors survive.
    """
    if not isinstance(sources, list) or len(sources) > MAX_WORKBOOKS:
        _fail("input_limit", "Merge input exceeds the supported source limit.")
    result = {"sources": [], "posts": [], "media": [], "runs": [], "errors": [], "warnings": []}
    seen_sources = set()
    for index, source in enumerate(sources, 1):
        if not isinstance(source, dict):
            _fail("invalid_records", "Merge input must contain validated result objects.")
        for kind in ("posts", "media", "runs"):
            rows = source.get(kind)
            if not isinstance(rows, list):
                _fail("invalid_records", "Merge input is missing a validated record list.")
            for item in rows:
                if not isinstance(item, dict) or "_blocked" not in item or "_reasons" not in item:
                    _fail("invalid_records", "Merge requires previously validated records.")
                row = copy.deepcopy(item)
                label = row.get("_source") or f"source-{index:06}"
                if not isinstance(label, str) or len(label) > 1024 or any(char in label for char in ("\x00", "\n", "\r", "\\")) or ":" in label or PurePosixPath(label).is_absolute() or ".." in PurePosixPath(label).parts:
                    _fail("invalid_source_path", "Source metadata must be a safe relative label.")
                digest = row.get("_source_sha256", source.get("source_sha256", ""))
                if not isinstance(digest, str) or (digest and not re.fullmatch(r"[0-9a-f]{64}", digest)):
                    _fail("invalid_records", "Source digest metadata is invalid.")
                row["_source"], row["_source_sha256"] = label, digest
                if (label, digest) not in seen_sources:
                    seen_sources.add((label, digest))
                    result["sources"].append({"relative_path": label, "sha256": digest})
                result[kind].append(row)
        for kind in ("errors", "warnings"):
            issues = source.get(kind, [])
            if not isinstance(issues, list):
                _fail("invalid_records", "Merge diagnostics must be lists.")
            result[kind].extend(copy.deepcopy(issues))
        if sum(len(result[kind]) for kind in ("posts", "media", "runs")) > MAX_COLLECTION_RECORDS:
            _fail("input_limit", "Merge input exceeds the total record limit.")
    result["sources"].sort(key=lambda item: (item["relative_path"], item["sha256"]))
    return _merge_result(result)


def check_handoff(root: Path, account: str, run_id: str, source_relative: str) -> None:
    """Verify the collector committed the daily result and accounts anchor.

    This checks one underlying collection run; skipped_daily must be resolved by
    the caller to its unambiguous committed run first. Lock/journal checks belong
    to the owning runner. Both files are always read-only.
    """
    root = Path(os.path.abspath(root))
    _source_date(source_relative)
    source = root.joinpath(*PurePosixPath(source_relative).parts)
    daily = read_workbook(source)
    runs = [row for row in daily["runs"] if row.get("계정명") == account and row.get("실행ID") == run_id]
    if len(runs) != 1 or runs[0]["_blocked"] or runs[0]["결과"] not in COMMITTED:
        _fail("handoff_run_uncommitted", "Handoff must reference one valid committed collection run.")
    run = runs[0]
    if run["수집일자(KST)"][:10] != _source_date(source_relative):
        _fail("handoff_run_date", "Committed run date differs from the result path.")
    accounts = _read_tables(root / "accounts.xlsx", {"계정": ACCOUNT_HEADERS})
    selected = [row for row in accounts["계정"] if row.get("계정명") == account]
    if len(selected) != 1 or selected[0]["_blocked"]:
        _fail("handoff_account_invalid", "Handoff account is missing, duplicated, or invalid.")
    entry = selected[0]
    expected_anchor = run["기존기준ID"] if run["결과"] == "partial" else run["다음기준ID"]
    if entry["최근실행ID"] != run_id or entry["최근결과파일"] != source_relative or entry["기준게시글ID"] != expected_anchor:
        _fail("handoff_not_committed", "Account run reference, source reference, or anchor has not been committed.")
    # Ensure the first file was not changed while accounts.xlsx was checked.
    if hashlib.sha256(_read_stable(source)).hexdigest() != daily["source_sha256"]:
        _fail("source_changed", "Result source changed while verifying the handoff.")
