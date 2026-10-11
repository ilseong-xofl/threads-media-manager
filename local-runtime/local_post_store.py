"""Source-independent posts; no collection rows or download request history."""
from datetime import datetime
import re

from threads_source.files import SourceError

ACCOUNT = ":local:"
POST_COLUMNS = ("account", "post_id", "created_at")
MEDIA_COLUMNS = ("media_id", "account", "post_id", "ordinal", "kind", "final_rel", "size", "sha256")
POST_SQL = """CREATE TABLE IF NOT EXISTS local_posts(
    account TEXT NOT NULL,post_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(account,post_id))"""
MEDIA_SQL = """CREATE TABLE IF NOT EXISTS local_post_media(
    media_id TEXT PRIMARY KEY,account TEXT NOT NULL,post_id TEXT NOT NULL,ordinal INTEGER NOT NULL CHECK(ordinal>0),
    kind TEXT NOT NULL,final_rel TEXT NOT NULL,size INTEGER NOT NULL,sha256 TEXT NOT NULL,
    UNIQUE(account,post_id,ordinal),FOREIGN KEY(account,post_id) REFERENCES local_posts(account,post_id))"""


def create_schema(db):
    db.execute(POST_SQL)
    db.execute(MEDIA_SQL)


def read(db, library_id=None):
    """Validate optional local ownership tables before adopting file references."""
    present = []
    for name, columns in (("local_posts", POST_COLUMNS), ("local_post_media", MEDIA_COLUMNS)):
        table = db.execute("SELECT type FROM sqlite_master WHERE name=?", (name,)).fetchone()
        present.append(bool(table))
        if table and (table[0] != "table" or
                tuple(row[1] for row in db.execute(f"PRAGMA table_info({name})")) != columns or
                db.execute("SELECT 1 FROM sqlite_master WHERE type='trigger' AND tbl_name=?", (name,)).fetchone()):
            raise SourceError("invalid_local_posts", "개인 등록 글의 저장 형식을 확인하세요.")
    if not any(present):
        return [], []
    if not all(present):
        raise SourceError("invalid_local_posts", "개인 등록 글의 첨부 연결을 확인하세요.")
    posts = [dict(zip(POST_COLUMNS, row)) for row in db.execute("SELECT * FROM local_posts")]
    media = [dict(zip(MEDIA_COLUMNS, row)) for row in db.execute("SELECT * FROM local_post_media ORDER BY ordinal,media_id")]
    keys, identifiers, ordinals = set(), set(), set()
    try:
        for post in posts:
            key = post["account"], post["post_id"]
            if (key[0] != ACCOUNT or not isinstance(key[1], str) or not re.fullmatch(r"[a-f0-9]{32}", key[1]) or
                    datetime.fromisoformat(post["created_at"]).tzinfo is None or key in keys):
                raise ValueError()
            keys.add(key)
        for item in media:
            key = item["account"], item["post_id"]
            ordinal = (*key, item["ordinal"])
            match = re.fullmatch(r"media/files/([a-f0-9]{32})/([a-f0-9]{32})\.(jpg|png|webp|gif|mp4|mov|webm)", item["final_rel"])
            if (key not in keys or not isinstance(item["media_id"], str) or item["media_id"] in identifiers or
                    not match or match[2] != item["media_id"] or (library_id is not None and match[1] != library_id) or
                    item["kind"] not in {"image", "video"} or
                    (item["kind"] == "image") != (match[3] in {"jpg", "png", "webp", "gif"}) or
                    type(item["ordinal"]) is not int or not 1 <= item["ordinal"] <= 100 or ordinal in ordinals or
                    type(item["size"]) is not int or not 0 < item["size"] <= (32*1024**2 if item["kind"] == "image" else 1024**3) or
                    not isinstance(item["sha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", item["sha256"])):
                raise ValueError()
            identifiers.add(item["media_id"])
            ordinals.add(ordinal)
        for key in keys:
            sequence = sorted(item["ordinal"] for item in media if (item["account"], item["post_id"]) == key)
            if not sequence or sequence != list(range(1, len(sequence)+1)):
                raise ValueError()
        if identifiers and db.execute("SELECT 1 FROM media WHERE media_id IN (SELECT media_id FROM local_post_media)").fetchone():
            raise ValueError()
        if db.execute("SELECT 1 FROM media JOIN local_posts USING(account,post_id)").fetchone():
            raise ValueError()
    except (ValueError, TypeError, KeyError) as exc:
        raise SourceError("invalid_local_posts", "개인 등록 글의 첨부 소유 정보를 확인하세요.") from exc
    return posts, media
