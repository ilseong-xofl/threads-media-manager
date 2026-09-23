"""App-side post readiness and narrowly owned logical source errors.

A stopped account scan is not a failed post. Collector files and its validation
policy remain unchanged; only complete individual posts are eligible locally.
"""
import copy

from . import excel_input, transport
from .state import StateError, safe_path

CLEANABLE = frozenset({"invalid_candidate", "unknown_address_state", "unknown_media_kind",
    "invalid_completeness", "attachment_count_mismatch", "invalid_integer", "blocked_post"})


def _unblock_running(data):
    allowed = {(row.get("계정명"), row.get("실행ID")) for row in data["runs"]
               if row.get("결과") == "running" and set(row.get("_reasons", [])) <= {"run_running"}}
    def remove(row, reasons):
        row["_reasons"] = [reason for reason in row.get("_reasons", []) if reason not in reasons]
        row["_blocked"] = bool(row["_reasons"])
    for row in data["runs"]:
        if (row.get("계정명"), row.get("실행ID")) in allowed:
            remove(row, {"run_running"})
    for row in data["posts"]:
        if (row.get("계정명"), row.get("확인실행ID")) in allowed:
            remove(row, {"uncommitted_run"})
    good = {(row.get("계정명"), row.get("게시글ID")) for row in data["posts"] if not row.get("_blocked")}
    for row in data["media"]:
        if (row.get("계정명"), row.get("확인실행ID")) in allowed:
            remove(row, {"uncommitted_run"} | ({"blocked_post"} if (row.get("계정명"), row.get("게시글ID")) in good else set()))


def normalize(root, data):
    data = copy.deepcopy(data)
    _unblock_running(data)
    if not data["errors"]:
        return data
    # Error row numbers belong to their original workbook, not a chosen merge
    # observation. Re-read only error-bearing sources before assigning ownership.
    rows = []
    sources = {error.get("source") for error in data["errors"]}
    for source in data["sources"]:
        relative = source["relative_path"]
        if None not in sources and relative not in sources:
            continue
        current = excel_input.read_workbook(safe_path(root, relative, require_file=True))
        if current["source_sha256"] != source["sha256"]:
            raise StateError("source_changed", "원본 오류를 확인하는 중 파일이 변경되었습니다.")
        before = copy.deepcopy(current)
        _unblock_running(current)
        for kind, sheet in (("posts", "게시글"), ("media", "미디어")):
            previous = {row["_row"]: row for row in before[kind]}
            for row in current[kind]:
                removed = set(previous[row["_row"]].get("_reasons", [])) - set(row.get("_reasons", []))
                rows.append((relative, sheet, row["_row"], row, removed))
    errors = []
    for error in data["errors"]:
        matches = [item for item in rows if item[1:3] == (error.get("sheet"), error.get("row")) and
                   (not error.get("source") or item[0] == error["source"])]
        if matches and error["code"] in {"uncommitted_run", "blocked_post"} and all(error["code"] in item[4] for item in matches):
            continue
        keys = {(item[3].get("계정명"), item[3].get("게시글ID")) for item in matches}
        value = dict(error)
        if len(keys) == 1 and all(isinstance(part, str) and part for part in next(iter(keys))):
            value["_post_key"] = next(iter(keys))
        errors.append(value)
    data["errors"] = errors
    return data


def error_is_owned(error, keys):
    return error.get("code") in CLEANABLE and tuple(error.get("_post_key", ())) in keys


def reason(data, post, media=None, *, saved=lambda item: False):
    key = post["계정명"], post["게시글ID"]
    run = next((row for row in data["runs"] if (row["계정명"], row["실행ID"]) == (key[0], post["확인실행ID"])), None)
    if (not run or run["결과"] not in excel_input.COMMITTED | {"running"} or run.get("_blocked") or
            post.get("_blocked") or post.get("캡션 상태") != "complete"):
        return "source_not_ready"
    media = media if media is not None else [row for row in data["media"] if (row["계정명"], row["게시글ID"]) == key]
    orders = [row.get("순서") for row in media]
    if (post.get("첨부 상태") != "complete" or not media or any(type(order) is not int for order in orders) or
            sorted(orders) != list(range(1, len(media) + 1)) or
            sum(row["종류"] == "image" for row in media) != post["이미지 수"] or
            sum(row["종류"] == "video" for row in media) != post["영상 수"]):
        return "attachment_not_ready"
    for item in media:
        if saved(item):
            continue
        if item.get("_blocked") or item["주소상태"] != "http_candidate" or not item["다운로드URL"]:
            return "attachment_not_ready"
        try:
            transport.validate_url(item["다운로드URL"])
        except transport.TransferError:
            return "attachment_not_ready"
    return None
