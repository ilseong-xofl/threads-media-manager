import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { validVersion } from '../shared/release-notes';

export const RELEASE_NOTES_FILE_NAME = 'release-notes.json';

/**
 * The version whose update notes this PC last closed, or null without a readable record. The
 * record only decides whether the notes show, so a damaged one counts as missing and the next
 * close replaces it.
 */
export function readSeenReleaseNotes(userData: string): string | null {
  try {
    const value: unknown = JSON.parse(
      readFileSync(join(userData, RELEASE_NOTES_FILE_NAME), 'utf8'),
    );
    if (typeof value !== 'object' || value === null) return null;
    const record = value as { version?: unknown; seen?: unknown };
    return record.version === 1 && validVersion(record.seen) ? record.seen : null;
  } catch {
    return null;
  }
}

/** Records `version` as seen. Synchronous, because the Squirrel install run quits right after. */
export function markReleaseNotesSeen(userData: string, version: string): void {
  if (!validVersion(version)) throw new Error('Invalid version');
  const path = join(userData, RELEASE_NOTES_FILE_NAME);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(userData, { recursive: true, mode: 0o700 });
    const handle = openSync(temporary, 'wx', 0o600);
    try {
      writeSync(handle, `${JSON.stringify({ version: 1, seen: version })}\n`);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Never created, or already renamed.
    }
    throw error;
  }
}
