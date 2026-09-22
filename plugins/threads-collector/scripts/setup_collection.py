#!/usr/bin/env python3
"""Prepare local collection storage without network access or third-party packages.

Only init writes files. Existing settings and account workbooks are never replaced.
This helper checks the workbook envelope, not account rows, browser login, or
collection readiness. Excel must be closed before init; lock markers are advisory.
"""

import argparse
import contextlib
import hashlib
import json
import os
from pathlib import Path
import posixpath
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = PLUGIN_ROOT / "skills/threads-collect/assets/accounts.xlsx"
XML_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
HEADERS = (
    "사용", "계정명", "URL", "메모", "기준게시글ID", "최근 시도(KST)",
    "최근 완료(KST)", "최근 결과", "최근실행ID", "최근결과파일", "특이사항",
)
STORAGE_DIRS = ("results", "backups", "_work")


class SetupError(Exception):
    def __init__(self, code, message, path=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.path = str(path) if path is not None else None

    def as_dict(self):
        result = {"code": self.code, "message": self.message}
        if self.path is not None:
            result["path"] = self.path
        return result


def absolute_path(value, label):
    path = Path(value)
    if not path.is_absolute():
        raise SetupError("absolute_path_required", f"{label}에는 절대 경로가 필요합니다.", path)
    if path.is_symlink():
        raise SetupError("symlink_not_supported", f"{label} 자체가 심볼릭 링크입니다.", path)
    resolved = path.resolve()
    # Resolve parent aliases first (e.g. macOS /tmp -> /private/tmp), then reject
    # the installed plugin and any Codex plugin cache as persistent user storage.
    parts = [part.casefold() for part in resolved.parts]
    in_cache = any(parts[i:i + 3] == [".codex", "plugins", "cache"]
                   for i in range(max(0, len(parts) - 2)))
    # A cached helper must also reject the original source checkout (and other
    # installed versions), whose path differs from this process's PLUGIN_ROOT.
    in_plugin_source = any((ancestor / ".codex-plugin/plugin.json").is_file()
                           for ancestor in (resolved, *resolved.parents))
    if resolved == PLUGIN_ROOT or PLUGIN_ROOT in resolved.parents or in_cache or in_plugin_source:
        raise SetupError("plugin_storage_forbidden", "플러그인 코드·캐시 밖의 사용자 폴더를 선택하세요.", resolved)
    return resolved


def require_regular_file(path, code):
    if path.is_symlink() or not path.is_file():
        raise SetupError(code, "일반 파일이어야 합니다. 기존 항목은 변경하지 않았습니다.", path)


def ensure_dir(path):
    if path.is_symlink():
        raise SetupError("symlink_not_supported", "자료 폴더 내부의 심볼릭 링크는 지원하지 않습니다.", path)
    if path.exists() and not path.is_dir():
        raise SetupError("path_collision", "필요한 폴더 위치에 다른 파일이 있습니다.", path)
    path.mkdir(parents=True, exist_ok=True)


def read_settings(config_path):
    if not config_path.exists() and not config_path.is_symlink():
        return None
    require_regular_file(config_path, "invalid_settings")
    try:
        data = json.loads(config_path.read_text(encoding="utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise SetupError("invalid_settings", "설정 파일을 읽을 수 없습니다. 덮어쓰지 않고 중단했습니다.", config_path) from exc
    if (not isinstance(data, dict) or type(data.get("schema_version")) is not int
            or data["schema_version"] != 1 or not isinstance(data.get("collection_root"), str)):
        raise SetupError("invalid_settings", "지원하는 설정 형식(schema_version=1)이 아닙니다.", config_path)
    root = absolute_path(data["collection_root"], "등록된 수집 폴더")
    return {"schema_version": 1, "collection_root": str(root)}


def workbook_cells(path):
    """Read the named sheet via its relationship, including shared/inline strings."""
    require_regular_file(path, "invalid_accounts")
    try:
        with zipfile.ZipFile(path) as archive:
            def xml(member):
                info = archive.getinfo(member)
                if info.file_size > 16 * 1024 * 1024:
                    raise SetupError("invalid_accounts", "양식 검사에 필요한 XML이 너무 큽니다.", path)
                return ET.fromstring(archive.read(member))

            workbook = xml("xl/workbook.xml")
            sheets = [s for s in workbook.iter(XML_NS + "sheet") if s.get("name") == "계정"]
            if len(sheets) != 1:
                raise SetupError("invalid_accounts", "'계정' 시트를 하나 포함한 양식이 필요합니다.", path)
            relationship_id = sheets[0].get(REL_NS + "id")
            relationships = xml("xl/_rels/workbook.xml.rels")
            matches = [r for r in relationships if r.get("Id") == relationship_id
                       and r.get("Type", "").endswith("/worksheet")
                       and r.get("TargetMode") != "External"]
            if len(matches) != 1:
                raise SetupError("invalid_accounts", "계정 시트 연결 정보를 확인할 수 없습니다.", path)
            target = matches[0].get("Target", "")
            member = posixpath.normpath(target.lstrip("/") if target.startswith("/")
                                        else posixpath.join("xl", target))
            if not member.startswith("xl/") or "\\" in member:
                raise SetupError("invalid_accounts", "계정 시트의 경로가 올바르지 않습니다.", path)
            shared = []
            if "xl/sharedStrings.xml" in archive.namelist():
                shared = ["".join(t.text or "" for t in si.iter(XML_NS + "t"))
                          for si in xml("xl/sharedStrings.xml")]
            cells = {}
            for cell in xml(member).iter(XML_NS + "c"):
                ref = cell.get("r", "")
                if ref not in {"A3", "B3"} and re.fullmatch(r"[A-Z]+6", ref) is None:
                    continue
                kind = cell.get("t", "")
                value = cell.findtext(XML_NS + "v", default="")
                if kind == "s":
                    index = int(value)
                    if index < 0:
                        raise ValueError("negative shared string index")
                    value = shared[index]
                elif kind == "inlineStr":
                    value = "".join(t.text or "" for t in cell.iter(XML_NS + "t"))
                if cell.find(XML_NS + "f") is not None and (ref in {"A3", "B3"} or value in HEADERS):
                    raise SetupError("invalid_accounts", "양식 표식과 필수 헤더에는 수식을 사용할 수 없습니다.", path)
                if ref in cells:
                    raise ValueError("duplicate cell")
                cells[ref] = value
            return cells
    except SetupError:
        raise
    except (zipfile.BadZipFile, KeyError, ET.ParseError, ValueError, IndexError, RuntimeError) as exc:
        raise SetupError("invalid_accounts", "accounts.xlsx가 손상되었거나 지원하는 양식이 아닙니다.", path) from exc


def validate_accounts(path):
    cells = workbook_cells(path)
    expected = {"A3": "형식 버전", "B3": "daily-v1"}
    if any(cells.get(key) != value for key, value in expected.items()):
        raise SetupError("invalid_accounts", "daily-v1 계정 양식의 표식이 일치하지 않습니다.", path)
    headers = [value for ref, value in cells.items() if re.fullmatch(r"[A-Z]+6", ref)]
    if any(headers.count(required) != 1 for required in HEADERS):
        raise SetupError("invalid_accounts", "6행 필수 헤더가 누락되었거나 중복되어 있습니다.", path)


def active_markers(root):
    return [p for p in (root / "_work/collector.lock", root / "~$accounts.xlsx",
                        root / ".~lock.accounts.xlsx#") if p.exists() or p.is_symlink()]


def require_recoverable_layout(root, has_settings):
    accounts = root / "accounts.xlsx"
    if has_settings and (not root.exists() or not accounts.exists()):
        raise SetupError("recovery_required", "등록된 자료 폴더 또는 accounts.xlsx가 없습니다. 빈 양식으로 재생성하지 않습니다.", root)
    if not accounts.exists():
        for name in STORAGE_DIRS:
            directory = root / name
            if directory.is_dir() and any(directory.iterdir()):
                raise SetupError("recovery_required", "기존 작업 자료가 있으나 accounts.xlsx가 없습니다. 계정 파일 복구가 먼저 필요합니다.", directory)


@contextlib.contextmanager
def exclusive_lock(path):
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as exc:
        raise SetupError("busy", "다른 실행의 잠금이 있습니다. 확인 없이 삭제하지 마세요.", path) from exc
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump({"operation": "init", "pid": os.getpid()}, stream)
            stream.flush()
            os.fsync(stream.fileno())
        yield
    finally:
        # Only our lock is eligible for cleanup; never remove a replaced lock.
        try:
            current = path.stat(follow_symlinks=False)
            if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                path.unlink()
        except FileNotFoundError:
            pass


def publish_new_file(path, content, validator):
    """Flush and validate before atomic no-clobber publication on a local filesystem."""
    descriptor, temporary_name = tempfile.mkstemp(prefix=".threads-setup-", suffix=path.suffix, dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        validator(temporary)
        try:
            os.link(temporary, path)
        except FileExistsError as exc:
            raise SetupError("concurrent_change", "파일이 다른 실행에서 생성되었습니다. 기존 파일은 변경하지 않았습니다.", path) from exc
        # Verify actual published bytes. A failure leaves the new file in place for
        # inspection/recovery; it must not delete user data or rewrite it.
        if hashlib.sha256(path.read_bytes()).digest() != hashlib.sha256(content).digest():
            raise SetupError("verification_failed", "저장 후 파일 내용이 달라졌습니다. 기존 자료를 보존하고 중단합니다.", path)
        validator(path)
    finally:
        temporary.unlink(missing_ok=True)


def status(config_value):
    config_path = absolute_path(config_value, "설정 파일")
    result = {"ok": True, "operation": "status", "config_path": str(config_path),
              "configured": False, "collection_root": None, "accounts_path": None,
              "accounts_exists": False, "accounts_format_valid": None,
              "setup_state": "not_configured", "login_checked": False}
    settings = read_settings(config_path)
    if settings is None:
        return result
    root = Path(settings["collection_root"])
    accounts = root / "accounts.xlsx"
    result.update(configured=True, collection_root=str(root), accounts_path=str(accounts),
                  accounts_exists=accounts.exists(), setup_state="incomplete")
    if not root.exists() or not accounts.exists():
        result.update(ok=False, setup_state="recovery_required", error={
            "code": "recovery_required", "message": "등록된 자료 폴더 또는 accounts.xlsx가 없습니다. 기존 자료 복구가 필요합니다."})
        return result
    if root.exists() and not root.is_dir():
        raise SetupError("path_collision", "등록된 수집 폴더 위치에 파일이 있습니다.", root)
    if accounts.exists() or accounts.is_symlink():
        validate_accounts(accounts)
        result["accounts_format_valid"] = True
    directories = {name: (root / name).is_dir() and not (root / name).is_symlink() for name in STORAGE_DIRS}
    result["directories"] = directories
    markers = active_markers(root)
    config_lock = config_path.with_name(config_path.name + ".init.lock")
    if config_lock.exists() or config_lock.is_symlink():
        markers.append(config_lock)
    result["blocking_markers"] = [str(p) for p in markers]
    if markers:
        result["setup_state"] = "busy"
    elif result["accounts_format_valid"] and all(directories.values()):
        result["setup_state"] = "prepared"
    return result


def initialize(config_value, root_value, template_path=None):
    config_path = absolute_path(config_value, "설정 파일")
    root = absolute_path(root_value, "수집 폴더")
    template = TEMPLATE_PATH if template_path is None else Path(template_path)
    # Check the settings before creating folders, then recheck under the lock.
    previous = read_settings(config_path)
    if previous and previous["collection_root"] != str(root):
        raise SetupError("root_change_unsupported", "등록된 수집 폴더 변경은 이번 버전에서 지원하지 않습니다.", config_path)
    require_recoverable_layout(root, previous is not None)
    ensure_dir(config_path.parent)
    with exclusive_lock(config_path.with_name(config_path.name + ".init.lock")):
        previous = read_settings(config_path)
        if previous and previous["collection_root"] != str(root):
            raise SetupError("root_change_unsupported", "등록된 수집 폴더가 변경되었습니다. 기존 자료는 보존합니다.", config_path)
        require_recoverable_layout(root, previous is not None)
        ensure_dir(root)
        # Validate all existing targets before preparing any child directories.
        for name in STORAGE_DIRS:
            item = root / name
            if item.is_symlink() or (item.exists() and not item.is_dir()):
                raise SetupError("path_collision", "필요한 자료 폴더 위치에 다른 항목이 있습니다.", item)
        markers = active_markers(root)
        if markers:
            raise SetupError("busy", "수집 중이거나 Excel 잠금 표식이 있습니다. 사용 중인지 확인하세요.", markers[0])
        ensure_dir(root / "_work")
        with exclusive_lock(root / "_work/collector.lock"):
            accounts = root / "accounts.xlsx"
            if accounts.exists() or accounts.is_symlink():
                validate_accounts(accounts)
            else:
                validate_accounts(template)
                publish_new_file(accounts, template.read_bytes(), validate_accounts)
            for name in STORAGE_DIRS:
                ensure_dir(root / name)
            if previous is None:
                content = (json.dumps({"schema_version": 1, "collection_root": str(root)},
                                      ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                publish_new_file(config_path, content, read_settings)
            verified = read_settings(config_path)
            if verified is None or verified["collection_root"] != str(root):
                raise SetupError("verification_failed", "설정 저장 후 등록 경로가 일치하지 않습니다.", config_path)
            validate_accounts(accounts)
    result = status(str(config_path))
    result["operation"] = "init"
    if result["setup_state"] != "prepared":
        result["ok"] = False
        result.setdefault("error", {
            "code": "setup_not_prepared",
            "message": "저장 후 점검에서 준비 완료를 확인하지 못했습니다. setup_state와 blocking_markers를 확인하세요.",
        })
        return result
    result["message"] = "저장 폴더와 계정 양식 준비 완료. 계정 등록과 Threads 로그인 확인은 별도입니다."
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    # Accept --config-path before or after the command without ambiguous defaults.
    parser.add_argument("--config-path", default=argparse.SUPPRESS)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("status", "init"):
        command = commands.add_parser(name)
        command.add_argument("--config-path", default=argparse.SUPPRESS)
        if name == "init":
            command.add_argument("--collection-root", required=True)
    args = parser.parse_args(argv)
    config_value = getattr(args, "config_path", str(Path.home() / ".threads-media-manager/settings.json"))
    try:
        result = status(config_value) if args.command == "status" else initialize(config_value, args.collection_root)
    except SetupError as exc:
        result = {"ok": False, "operation": args.command, "error": exc.as_dict()}
    except OSError as exc:
        result = {"ok": False, "operation": args.command,
                  "error": {"code": "filesystem_error", "message": str(exc),
                            "path": str(exc.filename) if exc.filename else None}}
    # CLI output is machine-readable JSON. ASCII escapes avoid encoding failures
    # in redirected Windows consoles while preserving Unicode after JSON parsing.
    print(json.dumps(result, ensure_ascii=True, indent=2))
    return 0 if result["ok"] else 2


if __name__ == "__main__":
    sys.exit(main())
