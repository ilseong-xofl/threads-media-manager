import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DAILY_DESCRIPTION_LIMIT,
  DAILY_NAME_LIMIT,
  DAILY_TEXT_LIMIT,
  DAILY_TRANSLATION_LIMIT,
  dailyTextLength,
  type DailyPersona,
} from '../shared/daily';
import { ViewError } from './collection';
import { isObject, validId, validRevision } from './managed-threads-store';
import { timestamp, uuid, type PublicationRequest } from './mobile-publication-data';

export const DAILY_LIBRARY_ID = 'daily';
export const DAILY_FILE_NAME = 'daily.json';

/** The exact request sent to the server. A retry must repeat it unchanged. */
export interface StoredDailySend {
  request: PublicationRequest;
  /** The server answered the create call. */
  confirmed: boolean;
  sentAt: string | null;
}
export interface StoredDailyPost {
  id: string;
  personaId: string;
  text: string;
  /** Korean rendering of a post generated in another language. Absent in files written before it. */
  translation?: string | null;
  createdAt: string;
  send: StoredDailySend | null;
  /** A cancelled send of this post still exists on the server and may yet be posted. */
  sentBefore: boolean;
  /** Final. Set once any send of this post reached Threads. */
  published: { sentAt: string | null } | null;
}
/**
 * A persona as this PC keeps it. `synced` (2026-11-18) is true once the server is known to hold
 * it; absent in files written before personas were kept on the server.
 */
export interface StoredDailyPersona extends DailyPersona {
  synced?: boolean;
}
/**
 * What one reply to a published post says in Korean (2026-11-21), with the reply text it was
 * written for: a reply edited on Threads no longer matches and goes without it.
 */
export interface StoredReplyNote {
  postId: string;
  threadsId: string;
  text: string;
  translation: string;
}
/**
 * The persona's answer to one reply of a published post (2026-11-21), kept from the draft until
 * this PC sees it on Threads: the text stays here even after it was sent.
 */
export interface StoredDailyAnswer {
  id: string;
  postId: string;
  /** The publication the reply belongs to, which the answer is sent for. */
  publicationId: string;
  replyThreadsId: string;
  text: string;
  /** The Korean it was written from, for a persona of another language. */
  translation?: string | null;
  createdAt: string;
  /** Written before the network call; `confirmed` once the server answered it. */
  send: { confirmed: boolean } | null;
  /** Earlier ids of this draft whose sends were cancelled; the phone may have posted one anyway. */
  cancelledIds?: string[];
}
/** The fetch of a post's replies that its window last showed on this PC (2026-11-23). */
export interface StoredReplySeen {
  postId: string;
  fetchedAt: string;
  /** Replies by other people that fetch had. */
  count: number;
}
export interface DailyPartition {
  service: string;
  ownerId: string;
  personas: StoredDailyPersona[];
  posts: StoredDailyPost[];
  /** Absent in files written before replies were read. */
  replyNotes?: StoredReplyNote[];
  /** Absent in files written before new replies were marked. */
  replySeen?: StoredReplySeen[];
  /** Absent in files written before answers were written. */
  answers?: StoredDailyAnswer[];
}
export interface DailyFile {
  version: 1;
  partitions: DailyPartition[];
}
export interface DailyScope {
  service: string;
  ownerId: string;
}

export const validDailyText = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  dailyTextLength(value) <= DAILY_TEXT_LIMIT &&
  !value.includes('\0');

export const validDailyTranslation = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim().length > 0 &&
  dailyTextLength(value) <= DAILY_TRANSLATION_LIMIT &&
  !value.includes('\0');

function validRequest(v: unknown, postId: string): v is PublicationRequest {
  return (
    isObject(v) &&
    uuid(v.requestId) &&
    validId(v.accountId) &&
    validRevision(v.expectedLifecycleVersion) &&
    validRevision(v.expectedOwnershipVersion) &&
    isObject(v.source) &&
    v.source.libraryId === DAILY_LIBRARY_ID &&
    v.source.postKey === postId &&
    timestamp(v.source.draftCreatedAt) &&
    v.source.draftRevision === 1 &&
    v.source.commentUpdatedAt === null &&
    validDailyText(v.caption) &&
    v.comment === null &&
    Array.isArray(v.media) &&
    v.media.length === 0
  );
}
function validPersona(v: unknown): v is DailyPersona {
  return (
    isObject(v) &&
    uuid(v.id) &&
    typeof v.name === 'string' &&
    v.name.trim().length > 0 &&
    v.name.length <= DAILY_NAME_LIMIT &&
    validId(v.accountId) &&
    ['ko', 'ja', 'en'].includes(String(v.language)) &&
    typeof v.description === 'string' &&
    v.description.length <= DAILY_DESCRIPTION_LIMIT &&
    timestamp(v.createdAt)
  );
}
function validPost(v: unknown): v is StoredDailyPost {
  return (
    isObject(v) &&
    uuid(v.id) &&
    uuid(v.personaId) &&
    validDailyText(v.text) &&
    (v.translation === undefined ||
      v.translation === null ||
      validDailyTranslation(v.translation)) &&
    timestamp(v.createdAt) &&
    typeof v.sentBefore === 'boolean' &&
    (v.send === null ||
      (isObject(v.send) &&
        validRequest(v.send.request, v.id) &&
        typeof v.send.confirmed === 'boolean' &&
        (v.send.sentAt === null || timestamp(v.send.sentAt)))) &&
    (v.published === null ||
      (isObject(v.published) && (v.published.sentAt === null || timestamp(v.published.sentAt))))
  );
}
export const threadsId = (v: unknown): v is string => typeof v === 'string' && /^\d{1,40}$/.test(v);
function validNote(v: unknown): v is StoredReplyNote {
  return (
    isObject(v) &&
    uuid(v.postId) &&
    threadsId(v.threadsId) &&
    validDailyText(v.text) &&
    validDailyTranslation(v.translation)
  );
}
function validSeen(v: unknown): v is StoredReplySeen {
  return (
    isObject(v) &&
    uuid(v.postId) &&
    timestamp(v.fetchedAt) &&
    Number.isSafeInteger(v.count) &&
    (v.count as number) >= 0
  );
}
function validAnswer(v: unknown): v is StoredDailyAnswer {
  return (
    isObject(v) &&
    uuid(v.id) &&
    uuid(v.postId) &&
    uuid(v.publicationId) &&
    threadsId(v.replyThreadsId) &&
    validDailyText(v.text) &&
    (v.translation === undefined ||
      v.translation === null ||
      validDailyTranslation(v.translation)) &&
    timestamp(v.createdAt) &&
    (v.send === null || (isObject(v.send) && typeof v.send.confirmed === 'boolean')) &&
    (v.cancelledIds === undefined || (Array.isArray(v.cancelledIds) && v.cancelledIds.every(uuid)))
  );
}
/** Checks the fields this version uses. Unknown fields are kept as they are. */
export function validDailyFile(v: unknown): v is DailyFile {
  if (!isObject(v) || v.version !== 1 || !Array.isArray(v.partitions)) return false;
  const scopes = new Set<string>();
  return v.partitions.every((p: unknown) => {
    if (
      !isObject(p) ||
      typeof p.service !== 'string' ||
      !p.service ||
      typeof p.ownerId !== 'string' ||
      !p.ownerId ||
      !Array.isArray(p.personas) ||
      !Array.isArray(p.posts) ||
      !p.personas.every(validPersona) ||
      !p.posts.every(validPost) ||
      (p.replyNotes !== undefined &&
        (!Array.isArray(p.replyNotes) || !p.replyNotes.every(validNote))) ||
      (p.replySeen !== undefined &&
        (!Array.isArray(p.replySeen) || !p.replySeen.every(validSeen))) ||
      (p.answers !== undefined && (!Array.isArray(p.answers) || !p.answers.every(validAnswer)))
    )
      return false;
    const scope = JSON.stringify([p.service, p.ownerId]);
    if (scopes.has(scope)) return false;
    scopes.add(scope);
    const personas = new Set(p.personas.map((item) => item.id));
    return (
      personas.size === p.personas.length &&
      new Set(p.personas.map((item) => item.accountId)).size === p.personas.length &&
      new Set(p.posts.map((item) => item.id)).size === p.posts.length &&
      p.posts.every((item) => personas.has(item.personaId)) &&
      new Set((p.answers ?? []).map((item) => item.id)).size === (p.answers ?? []).length
    );
  });
}

const unreadable = () =>
  new ViewError(
    'daily_storage',
    '일상 자료 파일을 읽지 못했습니다. 파일은 그대로 두었으니 관리자에게 문의하세요.',
  );

/**
 * Personas and daily posts of this PC. Plain JSON on purpose: nothing here is a secret and the
 * file must stay copyable to another PC. A file that cannot be read is never overwritten.
 */
export class DailyStore {
  private readonly path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly userData: string) {
    this.path = join(userData, DAILY_FILE_NAME);
  }
  private async load(): Promise<DailyFile> {
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, partitions: [] };
      throw unreadable();
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw unreadable();
    }
    if (!validDailyFile(value)) throw unreadable();
    // An older version that deleted a persona left the notes and answers of its posts behind;
    // drop them.
    for (const partition of value.partitions) {
      const posts = new Set(partition.posts.map((post) => post.id));
      if (partition.replyNotes)
        partition.replyNotes = partition.replyNotes.filter((note) => posts.has(note.postId));
      if (partition.replySeen)
        partition.replySeen = partition.replySeen.filter((seen) => posts.has(seen.postId));
      if (partition.answers)
        partition.answers = partition.answers.filter((answer) => posts.has(answer.postId));
    }
    return value;
  }
  private async save(file: DailyFile): Promise<void> {
    if (!validDailyFile(file))
      throw new ViewError('daily_storage', '일상 자료를 저장하지 못했습니다.');
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
      throw new ViewError('daily_storage', '일상 자료를 저장하지 못했습니다.');
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  private static partition(file: DailyFile, scope: DailyScope): DailyPartition {
    let partition = file.partitions.find(
      (p) => p.service === scope.service && p.ownerId === scope.ownerId,
    );
    if (!partition) {
      partition = { ...scope, personas: [], posts: [] };
      file.partitions.push(partition);
    }
    return partition;
  }
  read(scope: DailyScope): Promise<DailyPartition> {
    return this.serial(async () => DailyStore.partition(await this.load(), scope));
  }
  /** `change` edits the partition in place. Nothing is saved when it throws. */
  update<T>(scope: DailyScope, change: (partition: DailyPartition) => T): Promise<T> {
    return this.serial(async () => {
      const file = await this.load();
      const result = change(DailyStore.partition(file, scope));
      await this.save(file);
      return result;
    });
  }
}
