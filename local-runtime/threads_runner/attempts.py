"""Explicit attempt lineage. Historical requests and partial files remain immutable."""
import math
import re

from . import deletion_state
from .state import StateError


def retired_ids(db):
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='job_attempts'").fetchone():
        return set()
    rows = db.execute("""SELECT a.*, p.media_id AS previous_media, n.media_id AS next_media,
        p.status AS previous_status FROM job_attempts a
        LEFT JOIN jobs p ON p.job_id=a.previous_job_id
        LEFT JOIN jobs n ON n.job_id=a.replacement_job_id""").fetchall()
    links = {}
    for row in rows:
        previous, replacement = row['previous_job_id'], row['replacement_job_id']
        if (not all(isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value)
                    for value in (previous, replacement)) or previous == replacement or
                not row['previous_media'] or row['previous_media'] != row['next_media'] or
                row['previous_status'] not in {'planned', 'failed', 'interrupted'} or
                not isinstance(row['reason'], str) or not row['reason'] or
                type(row['created_at']) not in (int, float) or not math.isfinite(row['created_at'])):
            raise StateError('invalid_attempt_history', '다운로드 재시도 연결을 확인해야 합니다.')
        links[previous] = replacement
    # A damaged history must never hide an active or completed job.
    for initial in links:
        seen, current = set(), initial
        while current in links:
            if current in seen:
                raise StateError('invalid_attempt_history', '다운로드 재시도 연결이 순환합니다.')
            seen.add(current)
            current = links[current]
    return set(links)


def current_jobs(state, statuses=None, *, deleted=None):
    retired = retired_ids(state.db)
    return [row for row in deletion_state.active_jobs(state, statuses, deleted=deleted)
            if row['job_id'] not in retired]


def link(state, previous, replacement, reason):
    # Caller owns one transaction for new jobs, links, the revised plan and stop release.
    state.db.execute("""CREATE TABLE IF NOT EXISTS job_attempts(
        previous_job_id TEXT PRIMARY KEY REFERENCES jobs(job_id),
        replacement_job_id TEXT NOT NULL UNIQUE REFERENCES jobs(job_id),
        reason TEXT NOT NULL, created_at REAL NOT NULL)""")
    state.db.execute('INSERT INTO job_attempts VALUES(?,?,?,?)',
                     (previous, replacement, reason, state.clock()))
