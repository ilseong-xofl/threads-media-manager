"""Lazy, transactional upgrade of the optional local-edit table only."""
BASE_COLUMNS = ("edit_id", "account", "post_id", "source_media_id", "edit_type", "sequence", "created_at",
                "final_rel", "size", "sha256", "width", "height", "crop_json", "capture_time")
TRIM_COLUMNS = ("trim_start", "trim_end")


class EditSchemaError(ValueError):
    code = "invalid_edit_schema"


def create(db, name, trim):
    types = "'crop','capture','trim'" if trim else "'crop','capture'"
    extra = ",trim_start REAL,trim_end REAL" if trim else ""
    db.execute(f"""CREATE TABLE {name}(
        edit_id TEXT PRIMARY KEY, account TEXT NOT NULL, post_id TEXT NOT NULL,
        source_media_id TEXT NOT NULL, edit_type TEXT NOT NULL CHECK(edit_type IN ({types})),
        sequence INTEGER NOT NULL CHECK(sequence>0), created_at TEXT NOT NULL,
        final_rel TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
        width INTEGER NOT NULL, height INTEGER NOT NULL, crop_json TEXT, capture_time REAL{extra},
        UNIQUE(account,post_id,sequence))""")


def ensure(db, *, trim):
    row = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='media_edits'").fetchone()
    if not row:
        create(db, "media_edits", trim)
        return
    columns = tuple(item[1] for item in db.execute("PRAGMA table_info(media_edits)"))
    if columns not in (BASE_COLUMNS, BASE_COLUMNS+TRIM_COLUMNS):
        raise EditSchemaError("기존 편집 기록의 테이블 형식을 확인해야 합니다. 기록은 변경하지 않았습니다.")
    if not trim or columns == BASE_COLUMNS+TRIM_COLUMNS: return
    # Unknown schema extensions must be reviewed, never dropped as a side effect.
    if db.execute("SELECT 1 FROM sqlite_master WHERE tbl_name='media_edits' AND type IN ('index','trigger') AND sql IS NOT NULL").fetchone():
        raise EditSchemaError("편집 테이블에 추가된 인덱스·트리거를 확인해야 합니다.")
    for (name,) in db.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall():
        escaped = name.replace('"', '""')
        if any(item[2] == "media_edits" for item in db.execute(f'PRAGMA foreign_key_list("{escaped}")')):
            raise EditSchemaError("편집 테이블의 추가 참조를 확인해야 합니다.")
    if db.execute("SELECT 1 FROM sqlite_master WHERE type IN ('view','trigger') AND lower(sql) LIKE '%media_edits%'").fetchone():
        raise EditSchemaError("편집 테이블을 참조하는 추가 뷰·트리거를 확인해야 합니다.")
    temporary = "media_edits_trim_upgrade"
    if db.execute("SELECT 1 FROM sqlite_master WHERE name=?", (temporary,)).fetchone():
        raise EditSchemaError("완료되지 않은 편집 테이블 확장 기록을 확인해야 합니다.")
    create(db, temporary, True)
    names = ",".join(BASE_COLUMNS)
    db.execute(f"INSERT INTO {temporary}({names}) SELECT {names} FROM media_edits")
    db.execute("DROP TABLE media_edits")
    db.execute(f"ALTER TABLE {temporary} RENAME TO media_edits")
