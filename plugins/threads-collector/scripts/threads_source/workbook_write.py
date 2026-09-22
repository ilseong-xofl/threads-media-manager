"""Atomic daily-v1 writes. Preserve non-contract cells and untouched ZIP parts."""
from __future__ import annotations

import hashlib
import io
import os
from pathlib import Path
import re
import tempfile
import xml.etree.ElementTree as ET
import zipfile

from . import excel_input as excel
from .files import SourceError, file_hash, read_stable, safe_path, sync_directory

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('', NS)
DIGEST_HEADER = '수집입력SHA256'
TEMPLATE = Path(__file__).resolve().parents[2] / 'skills/threads-collect/assets/daily-results.xlsx'


def column(number):
    result = ''
    while number:
        number, digit = divmod(number - 1, 26)
        result = chr(65 + digit) + result
    return result


def unlocked(path):
    for name in ('~$' + path.name, '.~lock.' + path.name + '#'):
        marker = path.with_name(name)
        if marker.exists() or marker.is_symlink():
            raise SourceError('excel_busy', 'Excel에서 파일을 닫은 뒤 저장을 다시 실행하세요.')


def patch_workbook(raw, updates):
    """updates maps sheet -> [(row_number or None, {header: literal_value})]."""
    book = excel._Workbook(raw)
    replaced = {}
    try:
        for sheet, changes in updates.items():
            cells = book.rows(sheet)
            headers = {cell['value'].strip(): col for col, cell in cells[6].items() if cell['value'].strip()}
            part = book.sheets[sheet]
            original = book.archive.read(part)
            tree = ET.fromstring(original)
            data = tree.find(f'{{{NS}}}sheetData')
            rows = {int(row.get('r')): row for row in data}
            last = max(rows, default=6)
            def put(rownum, col, value):
                row = rows.get(rownum)
                if row is None:
                    row = ET.SubElement(data, f'{{{NS}}}row', r=str(rownum))
                    rows[rownum] = row
                address = column(col) + str(rownum)
                cell = next((c for c in row if c.get('r') == address), None)
                if cell is None:
                    cell = ET.SubElement(row, f'{{{NS}}}c', r=address)
                    # Reuse the template's data-cell style without copying values.
                    style = next((c.get('s') for c in rows.get(7, []) if c.get('r') == column(col) + '7'), None)
                    if style is not None:
                        cell.set('s', style)
                for child in list(cell):
                    cell.remove(child)
                if type(value) in (int, float):
                    cell.set('t', 'n')
                    ET.SubElement(cell, f'{{{NS}}}v').text = str(value)
                else:
                    text = '' if value is None else str(value)
                    if len(text) > 32767 or re.search(r'[\x00-\x08\x0b\x0c\x0e-\x1f]', text):
                        raise SourceError('invalid_cell', 'Excel 셀에 저장할 수 없는 길이 또는 문자가 있습니다.')
                    cell.set('t', 'inlineStr')
                    inline = ET.SubElement(cell, f'{{{NS}}}is')
                    ET.SubElement(inline, f'{{{NS}}}t', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'}).text = text
                row[:] = sorted(row, key=lambda c: (len(re.sub(r'\d', '', c.get('r', ''))), re.sub(r'\d', '', c.get('r', ''))))
            for number, values in changes:
                if number is None:
                    last += 1
                    number = last
                for header, value in values.items():
                    if header not in headers:
                        headers[header] = max(headers.values(), default=0) + 1
                        put(6, headers[header], header)
                    put(number, headers[header], value)
            data[:] = sorted(data, key=lambda row: int(row.get('r')))
            # Keep original namespace declarations, extension markup, notes,
            # validations, column widths and relationships outside sheetData.
            pattern = rb'<(?:\w+:)?sheetData\b[^>]*>.*?</(?:\w+:)?sheetData>'
            output, count = re.subn(pattern, lambda _: ET.tostring(data, encoding='utf-8'), original, count=1, flags=re.S)
            if count != 1:
                raise SourceError('unsupported_workbook', '지원하지 않는 Excel 시트 구조입니다.')
            end = column(max(headers.values())) + str(max(rows))
            output = re.sub(rb'(<(?:\w+:)?dimension\b[^>]*\bref=")[^"]*(")', lambda m: m[1] + ('A1:' + end).encode() + m[2], output)
            output = re.sub(rb'(<(?:\w+:)?autoFilter\b[^>]*\bref=")[^"]*(")', lambda m: m[1] + ('A6:' + end).encode() + m[2], output)
            replaced[part] = output
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, 'w') as archive:
            for entry in book.archive.infolist():
                archive.writestr(entry, replaced.get(entry.filename, book.archive.read(entry.filename)))
        return buffer.getvalue()
    finally:
        book.archive.close()


def publish(root, relative, content, before, validate, assert_owned):
    """Validate a sibling temporary file before replacing the destination."""
    path = safe_path(root, relative)
    unlocked(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_path(root, relative)
    temporary = None
    def unchanged():
        safe_path(root, relative, require_file=before is not None)
        if (file_hash(path) if path.exists() else None) != before:
            raise SourceError('source_changed', '저장 도중 Excel이 변경되었습니다. 임시 기록을 보존했습니다.')
        unlocked(path)
        assert_owned()
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.collection-', suffix='.xlsx', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        validate(temporary)
        expected = hashlib.sha256(content).hexdigest()
        if file_hash(temporary) != expected:
            raise SourceError('source_changed', '검증 중 임시 Excel이 변경되었습니다.')
        unchanged()
        if before is not None:
            # Content-addressed backup: exact previous bytes, never overwrite.
            backup_rel = f'backups/excel/{before}-{path.name}'
            backup = safe_path(root, backup_rel)
            backup.parent.mkdir(parents=True, exist_ok=True)
            safe_path(root, backup_rel)
            if backup.exists():
                if file_hash(backup) != before:
                    raise SourceError('backup_conflict', '기존 Excel 백업이 예상 내용과 다릅니다.')
            else:
                previous = read_stable(path, max_bytes=excel.MAX_ARCHIVE_BYTES)
                if hashlib.sha256(previous).hexdigest() != before:
                    raise SourceError('source_changed', '백업 중 Excel이 변경되었습니다.')
                with backup.open('xb') as stream:
                    stream.write(previous)
                    stream.flush()
                    os.fsync(stream.fileno())
                sync_directory(backup.parent)
        unchanged()
        os.replace(temporary, path)
        temporary = None
        directory = path.parent
        while directory.is_relative_to(root):
            sync_directory(directory)
            if directory == root:
                break
            directory = directory.parent
        validate(path)
        if file_hash(path) != expected:
            raise SourceError('source_changed', '검증 중 결과 Excel이 변경되었습니다.')
        return expected
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
