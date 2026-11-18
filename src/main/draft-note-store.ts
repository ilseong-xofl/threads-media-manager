import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { DAILY_TRANSLATION_LIMIT, dailyTextLength } from '../shared/daily';
import { ViewError } from './collection';
import type { DailyScope } from './daily-store';
import { isObject, validId, validRevision } from './managed-threads-store';
import { timestamp } from './mobile-publication-data';

export const DRAFT_NOTE_FILE_NAME = 'draft-notes.json';

/** One registration of one post. Deleting and registering again makes a new `draftCreatedAt`. */
export interface DraftNoteKey {
  libraryId: string;
  postKey: string;
  draftCreatedAt: string;
}
export interface StoredDraftNote extends DraftNoteKey {
  /** The draft revision `accountId` and `translation` were saved with; they hold only for it. */
  revision: number;
  accountId: string | null;
  translation: string | null;
  /** Holds only while the saved comment still has this `updatedAt`. */
  comment: { updatedAt: string; translation: string } | null;
}
interface Partition extends DailyScope {
  notes: StoredDraftNote[];
}
interface NoteFile {
  version: 1;
  partitions: Partition[];
}

export const validDraftTranslation = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  dailyTextLength(value) <= DAILY_TRANSLATION_LIMIT &&
  !value.includes('\0');

function validNote(v: unknown): v is StoredDraftNote {
  return (
    isObject(v) &&
    typeof v.libraryId === 'string' &&
    /^[a-f0-9]{32}$/.test(v.libraryId) &&
    typeof v.postKey === 'string' &&
    v.postKey.length > 0 &&
    v.postKey.length <= 512 &&
    timestamp(v.draftCreatedAt) &&
    validRevision(v.revision) &&
    (v.accountId === null || validId(v.accountId)) &&
    (v.translation === null || validDraftTranslation(v.translation)) &&
    (v.comment === null ||
      (isObject(v.comment) &&
        timestamp(v.comment.updatedAt) &&
        validDraftTranslation(v.comment.translation)))
  );
}
function validFile(v: unknown): v is NoteFile {
  if (!isObject(v) || v.version !== 1 || !Array.isArray(v.partitions)) return false;
  const scopes = new Set<string>();
  return v.partitions.every((p: unknown) => {
    if (
      !isObject(p) ||
      typeof p.service !== 'string' ||
      !p.service ||
      typeof p.ownerId !== 'string' ||
      !p.ownerId ||
      !Array.isArray(p.notes) ||
      !p.notes.every(validNote)
    )
      return false;
    const scope = JSON.stringify([p.service, p.ownerId]);
    if (scopes.has(scope)) return false;
    scopes.add(scope);
    return new Set(p.notes.map(same)).size === p.notes.length;
  });
}
const same = (key: DraftNoteKey) =>
  JSON.stringify([key.libraryId, key.postKey, key.draftCreatedAt]);
const failed = () => new ViewError('draft_note_storage', '계정 기록을 저장하지 못했습니다.');

/**
 * What this PC remembers about registered drafts besides the library database (2026-11-18): the
 * account a draft is written for and the Korean renderings of an AI caption and comment. They
 * belong to the signed-in service user, while the library is user-agnostic, so they live here
 * like `daily.json`. A file that cannot be read is never overwritten.
 */
export class DraftNoteStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string) {
    this.path = join(userData, DRAFT_NOTE_FILE_NAME);
  }
  private async load(): Promise<NoteFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, partitions: [] };
      throw failed();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw failed();
    }
    if (!validFile(value)) throw failed();
    return value;
  }
  private async save(file: NoteFile): Promise<void> {
    if (!validFile(file)) throw failed();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await mkdir(this.userData, { recursive: true, mode: 0o700 });
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(file)}\n`, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temporary, this.path);
    } catch {
      await unlink(temporary).catch(() => {});
      throw failed();
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  get(scope: DailyScope, key: DraftNoteKey): Promise<StoredDraftNote | null> {
    return this.serial(async () => {
      const partition = (await this.load()).partitions.find(
        (p) => p.service === scope.service && p.ownerId === scope.ownerId,
      );
      return partition?.notes.find((note) => same(note) === same(key)) ?? null;
    });
  }
  /** `change` gets the stored note, or null, and returns the note to keep, or null to drop it. */
  update(
    scope: DailyScope,
    key: DraftNoteKey,
    change: (note: StoredDraftNote | null) => StoredDraftNote | null,
  ): Promise<void> {
    return this.serial(async () => {
      const file = await this.load();
      let partition = file.partitions.find(
        (p) => p.service === scope.service && p.ownerId === scope.ownerId,
      );
      if (!partition) {
        partition = { ...scope, notes: [] };
        file.partitions.push(partition);
      }
      const at = partition.notes.findIndex((note) => same(note) === same(key));
      const next = change(at < 0 ? null : partition.notes[at]);
      if (next) partition.notes.splice(at < 0 ? partition.notes.length : at, at < 0 ? 0 : 1, next);
      else if (at >= 0) partition.notes.splice(at, 1);
      else return;
      await this.save(file);
    });
  }
}
