import { randomUUID } from 'node:crypto';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_DESCRIPTION_LIMIT,
  DAILY_KOREAN_DRAFT_LIMIT,
  DAILY_NAME_LIMIT,
  DAILY_TEXT_LIMIT,
  type DailyAnswer,
  type DailyAnswerState,
  type DailyDraft,
  type DailyLinkResult,
  type DailyPersona,
  type DailyPost,
  type DailyRepliesResult,
  type DailyReply,
  type DailyReplyThread,
  type DailyResult,
  type DailyView,
  type DailyWaitingNote,
  dailyTextLength,
} from '../shared/daily';
import type { MobilePublication } from '../shared/mobile-publications';
import { ViewError } from './collection';
import {
  DAILY_LIBRARY_ID,
  threadsId,
  validDailyText,
  validDailyTranslation,
  type DailyPartition,
  type DailyScope,
  type StoredDailyAnswer,
  type StoredDailyPost,
} from './daily-store';
import { exactKeys, isObject, parseManagedAccount, validId } from './managed-threads-store';
import {
  parsePublicationResponse,
  parsePublications,
  timestamp,
  uuid,
  type PublicationRequest,
} from './mobile-publication-data';
import { validUrl } from './open-post-link';
import { ServiceApiError, type ServiceApiClient, type ServiceBusinessContext } from './service-api';

type Client = Pick<
  ServiceApiClient,
  | 'getBusinessContext'
  | 'assertBusinessContext'
  | 'publicationRequest'
  | 'managedThreadsRequest'
  | 'personaRequest'
  | 'replyRequest'
>;
interface Store {
  read(scope: DailyScope): Promise<DailyPartition>;
  update<T>(scope: DailyScope, change: (partition: DailyPartition) => T): Promise<T>;
}
interface Options {
  client: Client;
  store: Store;
  service: string;
  /** Writes three posts for the persona. Throws a ViewError the user can read. */
  generate(persona: DailyPersona, recentPosts: string[], today: string): Promise<DailyDraft[]>;
  /** Says in Korean what one post of the persona says. Throws a ViewError the user can read. */
  translate(persona: DailyPersona, text: string): Promise<string>;
  /** Writes a Korean draft as a post in the persona's language. Throws a readable ViewError. */
  compose(persona: DailyPersona, korean: string): Promise<string>;
  /**
   * Writes a Korean answer draft as the persona's answer in its language. It is never handed the
   * reply being answered. Throws a readable ViewError.
   */
  composeAnswer(persona: DailyPersona, korean: string): Promise<string>;
  /** Says in Korean what replies to one post say, by reply id. Throws a readable ViewError. */
  translateReplies(
    persona: DailyPersona,
    post: string,
    replies: { id: string; text: string }[],
  ): Promise<{ id: string; korean: string }[]>;
  /** Opens an https address in the user's browser. */
  openExternal(url: string): Promise<void>;
  now?: () => Date;
}
/** What the server last said about one send. Memory only; rebuilt by `state()`. */
interface Remote {
  requestId: string;
  note: DailyWaitingNote | null;
  started: boolean;
}

const RECENT_POSTS = 30;
const LANGUAGES: CaptionLanguage[] = ['ko', 'ja', 'en'];
const EMPTY: DailyView = {
  personas: [],
  posts: [],
  generatingPersonaId: null,
  translatingPostId: null,
  translatingRepliesPostId: null,
  unsyncedPersonas: 0,
};
/** How much reply text one [한국어 뜻 보기] hands to ChatGPT (2026-11-21): the result fits 64KiB and 180s. */
const REPLY_BATCH = 4000;
/** The server's summary of one post's replies. Memory only; rebuilt when the board is read. */
interface ReplySummary {
  publicationId: string;
  fetchedAt: string;
  count: number;
  answers: { queued: number; failed: number; unknown: number };
}
type AnswerStatus = 'queued' | 'failed' | 'unknown' | 'published' | 'cancelled';
const ANSWER_STATUSES: AnswerStatus[] = ['queued', 'failed', 'unknown', 'published', 'cancelled'];
/** Not yet ended: the phone still has it. */
const unfinished = (status: AnswerStatus) =>
  status === 'queued' || status === 'failed' || status === 'unknown';
/** One answer as the server sends it to this PC; fields this PC does not use are left out. */
interface ServerAnswer {
  id: string;
  replyThreadsId: string;
  text: string;
  status: AnswerStatus;
  /** The Threads number of a posted answer; null until a fetch or a phone report gives it. */
  threadsId: string | null;
  errorCode: number | null;
  createdAt: string;
  publishedAt: string | null;
}
function serverAnswer(value: unknown): ServerAnswer | null {
  if (
    !isObject(value) ||
    !uuid(value.id) ||
    !threadsId(value.replyThreadsId) ||
    !validDailyText(value.text) ||
    !ANSWER_STATUSES.includes(value.status as AnswerStatus) ||
    !(value.threadsId === null || threadsId(value.threadsId)) ||
    !(value.errorCode === null || Number.isSafeInteger(value.errorCode)) ||
    !timestamp(value.createdAt) ||
    !(value.publishedAt === null || timestamp(value.publishedAt))
  )
    return null;
  return {
    id: value.id,
    replyThreadsId: value.replyThreadsId,
    text: value.text,
    status: value.status as AnswerStatus,
    threadsId: value.threadsId as string | null,
    errorCode: value.errorCode as number | null,
    createdAt: value.createdAt,
    publishedAt: value.publishedAt as string | null,
  };
}
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
/** One reply as the server sends it to this PC. */
interface ServerReply {
  threadsId: string;
  parentThreadsId: string;
  username: string;
  text: string;
  permalink: string | null;
  mediaType: string;
  ownedByMe: boolean;
  postedAt: string;
}
/** One post's replies and answers as last read from the server. */
interface ThreadRead {
  publicationId: string;
  fetchedAt: string | null;
  rootThreadsId: string | null;
  replies: ServerReply[];
  answers: ServerAnswer[];
}
/**
 * The server refused an answer and holds none of that id, so it may become a draft again. A lost
 * answer or a sign-in to renew leaves it as sent: the same id may be repeated.
 */
const refusedAnswer = (error: unknown) =>
  error instanceof ServiceApiError &&
  (error.code === 'MIGRATION_REQUIRED' ||
    (error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 403));
/**
 * The server cannot show replies: an older build without the routes, or one whose tables are not
 * created. The board then simply shows no replies, as before.
 */
const noReplyStore = (error: unknown) =>
  error instanceof ServiceApiError &&
  (error.code === 'MIGRATION_REQUIRED' ||
    (error.code === 'REPLY_REQUEST_FAILED' && error.status === 404));
/** Only a Threads page is opened from a reply (2026-11-21), never another site it may name. */
const THREADS_HOSTS = ['threads.com', 'www.threads.com', 'threads.net', 'www.threads.net'];
const threadsLink = (url: string) =>
  validUrl(url) &&
  new URL(url).protocol === 'https:' &&
  THREADS_HOSTS.includes(new URL(url).hostname);
function replySummaries(value: unknown): Map<string, ReplySummary> | null {
  if (!isObject(value) || !Array.isArray(value.posts)) return null;
  const summaries = new Map<string, ReplySummary>();
  for (const row of value.posts) {
    if (!isObject(row)) return null;
    // A daily post this PC did not write (its keys are UUIDs) has no card here; the rest stand.
    if (!uuid(row.postKey)) continue;
    if (
      !uuid(row.publicationId) ||
      !timestamp(row.fetchedAt) ||
      !count(row.count) ||
      !isObject(row.answers) ||
      !count(row.answers.queued) ||
      !count(row.answers.failed) ||
      !count(row.answers.unknown)
    )
      return null;
    summaries.set(row.postKey, {
      publicationId: row.publicationId,
      fetchedAt: row.fetchedAt,
      count: row.count as number,
      answers: {
        queued: row.answers.queued as number,
        failed: row.answers.failed as number,
        unknown: row.answers.unknown as number,
      },
    });
  }
  return summaries;
}
function serverReply(value: unknown): ServerReply | null {
  if (
    !isObject(value) ||
    !threadsId(value.threadsId) ||
    !threadsId(value.parentThreadsId) ||
    typeof value.username !== 'string' ||
    !value.username ||
    value.username.length > 100 ||
    typeof value.text !== 'string' ||
    dailyTextLength(value.text) > DAILY_TEXT_LIMIT ||
    !(
      value.permalink === null ||
      (typeof value.permalink === 'string' &&
        value.permalink.startsWith('https://') &&
        value.permalink.length <= 500)
    ) ||
    typeof value.mediaType !== 'string' ||
    !value.mediaType ||
    value.mediaType.length > 40 ||
    typeof value.ownedByMe !== 'boolean' ||
    !timestamp(value.postedAt)
  )
    return null;
  return {
    threadsId: value.threadsId,
    parentThreadsId: value.parentThreadsId,
    username: value.username,
    text: value.text,
    permalink: value.permalink,
    mediaType: value.mediaType,
    ownedByMe: value.ownedByMe,
    postedAt: value.postedAt,
  };
}
/**
 * The replies the next [한국어 뜻 보기] writes in Korean: other people's replies with text and no
 * rendering, in the server's order (newest first), until the text would pass `limit` characters.
 */
export function dailyReplyBatch(replies: DailyReply[], limit = REPLY_BATCH): DailyReply[] {
  const batch: DailyReply[] = [];
  let length = 0;
  for (const reply of replies) {
    if (reply.ownedByMe || !reply.text.trim() || reply.translation !== null) continue;
    length += dailyTextLength(reply.text);
    if (length > limit) break;
    batch.push(reply);
  }
  return batch;
}
/**
 * The server has nowhere to keep personas: an older build without the routes, or one whose table
 * is not created. A persona the server never held (`synced` is not true) may then be changed on
 * this PC alone, because nothing there can differ and the next sync uploads it; the PC must work
 * whichever of the two is updated first. A persona the server did hold is never changed here
 * alone: its server copy would win at the next sync and undo the change.
 */
const noPersonaStore = (error: unknown) =>
  error instanceof ServiceApiError &&
  (error.code === 'MIGRATION_REQUIRED' ||
    (error.code === 'PERSONA_REQUEST_FAILED' && error.status === 404));
/** What the server keeps of a persona. Posts and their Korean renderings stay on this PC. */
const PERSONA_FIELDS = ['name', 'accountId', 'language', 'description', 'createdAt'] as const;
/** One persona as the server sends it, or null when it is not one. */
function remotePersona(value: unknown): DailyPersona | null {
  if (
    !isObject(value) ||
    !uuid(value.id) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > DAILY_NAME_LIMIT ||
    !validId(value.accountId) ||
    !LANGUAGES.includes(value.language as CaptionLanguage) ||
    typeof value.description !== 'string' ||
    value.description.length > DAILY_DESCRIPTION_LIMIT ||
    !timestamp(value.createdAt)
  )
    return null;
  return {
    id: value.id,
    name: value.name,
    accountId: value.accountId,
    language: value.language as CaptionLanguage,
    description: value.description,
    createdAt: value.createdAt,
  };
}

/** The PC's calendar date. The writer only needs the time of year, so the time zone is no matter. */
const localDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

function fail(code: string, message: string): never {
  throw new ViewError(code, message);
}
const invalid = (): never => fail('daily_input', '입력한 내용을 확인해 주세요.');
const safeProblem = (error: unknown) =>
  error instanceof ViewError || error instanceof ServiceApiError
    ? { code: error.code, message: error.message }
    : { code: 'daily_failed', message: '일상 글 작업을 끝내지 못했습니다. 다시 시도해 주세요.' };

/** A send of this PC that must not stay postable once another send of the post is published. */
interface Leftover {
  requestId: string;
  row: { id: string; version: number } | null;
}
type Verdict =
  | { kind: 'published'; sentAt: string | null; leftover: Leftover | null }
  | { kind: 'draft' }
  | { kind: 'waiting'; sentAt: string | null; note: DailyWaitingNote | null; started: boolean }
  | { kind: 'unchanged' };

/** Reads the server's publications of one post. The server, not this PC, decides the state. */
export function dailyVerdict(post: StoredDailyPost, rows: MobilePublication[]): Verdict {
  // A cancelled send that the phone posted anyway still ends as a published root.
  const published = rows.find((row) => row.rootStatus === 'published');
  const row = post.send
    ? rows.find((item) => item.requestId === post.send!.request.requestId)
    : undefined;
  if (published) {
    // The post was sent again after a cancel, and the cancelled send was the one posted.
    const leftover =
      post.send && row?.id !== published.id && (!row || row.rootStatus === 'queued')
        ? {
            requestId: post.send.request.requestId,
            row: row ? { id: row.id, version: row.version } : null,
          }
        : null;
    return { kind: 'published', sentAt: published.sentAt, leftover };
  }
  if (!post.send) return { kind: 'unchanged' };
  if (!row || row.status === 'uploading')
    return { kind: 'waiting', sentAt: null, note: 'unconfirmed', started: false };
  if (row.status === 'cancelled') return { kind: 'draft' };
  if (row.status === 'started')
    return {
      kind: 'waiting',
      sentAt: row.sentAt,
      note: row.rootStatus === 'failed' ? 'failed' : 'check_phone',
      started: true,
    };
  return {
    kind: 'waiting',
    sentAt: row.sentAt,
    note: row.status === 'expired' ? 'expired' : null,
    started: false,
  };
}

export class DailyController {
  private mutating = false;
  private generatingPersonaId: string | null = null;
  private translatingPostId: string | null = null;
  private translatingRepliesPostId: string | null = null;
  private composing = false;
  private readonly remote = new Map<string, Remote>();
  /** By post id; empty while the server cannot show replies. */
  private replySummary = new Map<string, ReplySummary>();
  /**
   * The replies and answers last read, by post (2026-11-21): the replies an answer may go to and
   * the only Threads addresses a link may open. A late read of one post never replaces another's.
   * `scope` is the service and user they were read for; after a change of either they are not
   * used. Memory only.
   */
  private readonly reads = new Map<string, { scope: string; read: ThreadRead }>();
  /** A sync with the server that is under way; changes wait for it. */
  private syncing: Promise<void> | null = null;
  /** Server personas the last sync left out because another persona here uses their account. */
  private conflicts = 0;
  constructor(private readonly options: Options) {}
  /** A send, cancel, save or sync is talking to the server or the file. */
  get busy(): boolean {
    return this.mutating || this.syncing !== null;
  }
  /** ChatGPT is writing: posts, a Korean rendering, or a post from a Korean draft. */
  get generating(): boolean {
    return (
      this.generatingPersonaId !== null ||
      this.translatingPostId !== null ||
      this.translatingRepliesPostId !== null ||
      this.composing
    );
  }
  get active(): boolean {
    return this.mutating || this.generating;
  }
  private now(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
  private scope(context: ServiceBusinessContext): DailyScope {
    return { service: this.options.service, ownerId: context.ownerId };
  }
  private assert(context: ServiceBusinessContext) {
    this.options.client.assertBusinessContext(context);
  }
  private async request(
    context: ServiceBusinessContext,
    operation: Parameters<Client['publicationRequest']>[1],
    id?: string,
    body?: unknown,
  ) {
    this.assert(context);
    const response = await this.options.client.publicationRequest(context, operation, id, body);
    this.assert(context);
    return response;
  }
  private async list(context: ServiceBusinessContext, postId: string) {
    const rows = parsePublications(
      await this.request(context, 'list', undefined, {
        libraryId: DAILY_LIBRARY_ID,
        postKey: postId,
      }),
      0,
    );
    if (
      rows.some(
        (row) =>
          row.source.libraryId !== DAILY_LIBRARY_ID ||
          row.source.postKey !== postId ||
          row.media.length ||
          row.comment,
      )
    )
      fail('INVALID_RESPONSE', '다른 글의 응답을 받았습니다.');
    return rows;
  }
  private async accounts(context: ServiceBusinessContext) {
    const raw = await this.options.client.managedThreadsRequest(context, 'list');
    this.assert(context);
    if (!isObject(raw) || !Array.isArray(raw.accounts))
      return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    try {
      return raw.accounts.map((account) => parseManagedAccount(account, context.ownerId));
    } catch {
      return fail('INVALID_RESPONSE', '계정 목록을 확인하지 못했습니다.');
    }
  }
  private async personas(
    context: ServiceBusinessContext,
    operation: Parameters<Client['personaRequest']>[1],
    id?: string,
    body?: unknown,
  ) {
    this.assert(context);
    const response = await this.options.client.personaRequest(context, operation, id, body);
    this.assert(context);
    return response;
  }
  /**
   * Brings this PC's personas and the server's together (2026-11-18). The file stays complete, so
   * everything else keeps reading it; the server copy is what the phone and another PC see.
   * - only on the server: taken into the file (a new PC);
   * - only here: created on the server, which never overwrites an id it already has (the first
   *   move of older data, a restored file, a server database that was reset);
   * - on both: the server's fields win, and fields this version does not know are kept.
   * A server that cannot be read leaves the file as it is. Only a changed sign-in throws.
   */
  private async sync(context: ServiceBusinessContext): Promise<void> {
    const scope = this.scope(context);
    this.conflicts = 0;
    /** A failed call leaves things as they are, but a sign-in the server refuses must surface. */
    const tolerate = (error: unknown) => {
      this.assert(context);
      if (error instanceof ServiceApiError && error.code === 'AUTH_REQUIRED') throw error;
    };
    let remote: DailyPersona[];
    try {
      const raw = await this.personas(context, 'list');
      const rows = isObject(raw) && Array.isArray(raw.personas) ? raw.personas : null;
      const parsed = rows?.map(remotePersona);
      if (!parsed || parsed.some((persona) => !persona)) return;
      remote = parsed as DailyPersona[];
    } catch (error) {
      return tolerate(error);
    }
    const onServer = new Set(remote.map((persona) => persona.id));
    const before = await this.options.store.read(scope);
    for (const persona of before.personas.filter((p) => !onServer.has(p.id)))
      try {
        const { id, name, accountId, language, description, createdAt } = persona;
        await this.personas(context, 'create', undefined, {
          id,
          name,
          accountId,
          language,
          description,
          createdAt,
        });
        onServer.add(id);
      } catch (error) {
        // It stays on this PC and is counted as unsynced; the next sync tries again.
        tolerate(error);
      }
    /** Applies the server's personas; says how many it left out and whether anything changed. */
    const take = (partition: DailyPartition) => {
      let conflicts = 0;
      let changed = false;
      for (const theirs of remote) {
        if (
          partition.personas.some((p) => p.accountId === theirs.accountId && p.id !== theirs.id)
        ) {
          conflicts += 1;
          continue;
        }
        const mine = partition.personas.find((p) => p.id === theirs.id);
        if (!mine) partition.personas.push({ ...theirs });
        else if (PERSONA_FIELDS.every((field) => mine[field] === theirs[field])) continue;
        else for (const field of PERSONA_FIELDS) Object.assign(mine, { [field]: theirs[field] });
        changed = true;
      }
      for (const mine of partition.personas) {
        const synced = onServer.has(mine.id);
        if ((mine.synced === true) === synced) continue;
        mine.synced = synced;
        changed = true;
      }
      return { conflicts, changed };
    };
    const first = take(structuredClone(before));
    let conflicts = first.conflicts;
    // The file is written only when something really differs: this runs at every look.
    if (first.changed)
      await this.options.store.update(scope, (partition) => {
        ({ conflicts } = take(partition));
        return partition;
      });
    this.conflicts = conflicts;
  }
  private view(partition: DailyPartition): DailyView {
    return {
      unsyncedPersonas:
        partition.personas.filter((persona) => persona.synced !== true).length + this.conflicts,
      personas: partition.personas.map((persona) => ({
        id: persona.id,
        name: persona.name,
        accountId: persona.accountId,
        language: persona.language,
        description: persona.description,
        createdAt: persona.createdAt,
      })),
      posts: partition.posts.map((post): DailyPost => {
        const base = {
          id: post.id,
          personaId: post.personaId,
          text: post.text,
          translation: post.translation ?? null,
          createdAt: post.createdAt,
          replies: null,
        };
        if (post.published) {
          const replies = this.replySummary.get(post.id);
          return {
            ...base,
            state: 'published',
            note: null,
            started: false,
            sentAt: post.published.sentAt,
            replies: replies
              ? { fetchedAt: replies.fetchedAt, count: replies.count, answers: replies.answers }
              : null,
          };
        }
        if (!post.send)
          return { ...base, state: 'draft', note: null, started: false, sentAt: null };
        const remote = this.remote.get(post.id);
        const known = remote?.requestId === post.send.request.requestId ? remote : null;
        return {
          ...base,
          state: 'waiting',
          note: known ? known.note : post.send.confirmed ? null : 'unconfirmed',
          started: known?.started ?? false,
          sentAt: post.send.sentAt,
        };
      }),
      generatingPersonaId: this.generatingPersonaId,
      translatingPostId: this.translatingPostId,
      translatingRepliesPostId: this.translatingRepliesPostId,
    };
  }
  /**
   * Reads which published posts have replies, once per look at the board (2026-11-21). A server
   * without replies leaves them out; any other failure keeps what was last read.
   */
  private async readReplySummary(context: ServiceBusinessContext) {
    try {
      this.assert(context);
      const summaries = replySummaries(await this.options.client.replyRequest(context, 'summary'));
      this.assert(context);
      if (summaries) this.replySummary = summaries;
    } catch (error) {
      this.assert(context);
      if (noReplyStore(error)) this.replySummary = new Map();
      else if (error instanceof ServiceApiError && error.code === 'AUTH_REQUIRED') throw error;
    }
  }
  /** The replies the server keeps for one published post. Nothing of them is stored here. */
  private async serverReplies(context: ServiceBusinessContext, postId: string) {
    const summary = this.replySummary.get(postId);
    if (!summary)
      return fail('daily_replies', '댓글을 찾을 수 없습니다. 일상 화면을 다시 확인하세요.');
    this.assert(context);
    const raw = await this.options.client.replyRequest(context, 'get', summary.publicationId);
    this.assert(context);
    const replies =
      isObject(raw) && Array.isArray(raw.replies) ? raw.replies.map(serverReply) : null;
    const answers =
      isObject(raw) && Array.isArray(raw.answers) ? raw.answers.map(serverAnswer) : null;
    if (
      !isObject(raw) ||
      !(raw.fetchedAt === null || timestamp(raw.fetchedAt)) ||
      !(raw.rootThreadsId === null || threadsId(raw.rootThreadsId)) ||
      !replies ||
      replies.some((reply) => !reply) ||
      !answers ||
      answers.some((answer) => !answer)
    )
      return fail('INVALID_RESPONSE', '댓글 목록을 확인하지 못했습니다.');
    const read: ThreadRead = {
      publicationId: summary.publicationId,
      fetchedAt: raw.fetchedAt as string | null,
      rootThreadsId: raw.rootThreadsId as string | null,
      replies: replies as ServerReply[],
      answers: answers as ServerAnswer[],
    };
    this.reads.set(postId, { scope: JSON.stringify(this.scope(context)), read });
    return read;
  }
  /** The replies with this PC's Korean renderings, each only for the text it was written for. */
  private static thread(
    postId: string,
    partition: DailyPartition,
    read: ThreadRead,
  ): DailyReplyThread {
    const notes = (partition.replyNotes ?? []).filter((note) => note.postId === postId);
    const mine = (partition.answers ?? [])
      .filter((answer) => answer.postId === postId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const server = (id: string) => read.answers.find((answer) => answer.id === id);
    const answers = mine.flatMap((answer): DailyAnswer[] => {
      // The server decides wherever it holds the id.
      const theirs = server(answer.id);
      const state: AnswerStatus | DailyAnswerState = theirs
        ? theirs.status
        : !answer.send
          ? 'draft'
          : answer.send.confirmed
            ? 'queued'
            : 'unconfirmed';
      // Settled by the next read: it is shown as a reply, or it is a draft again.
      if (state === 'published' || state === 'cancelled') return [];
      return [
        {
          id: answer.id,
          replyThreadsId: answer.replyThreadsId,
          text: theirs?.text ?? answer.text,
          translation: answer.translation ?? null,
          state,
          errorCode: theirs?.errorCode ?? null,
          postedBefore:
            state === 'draft' &&
            (answer.cancelledIds ?? []).some((id) => server(id)?.status === 'published'),
        },
      ];
    });
    // The server decides: an unfinished answer this PC does not hold is shown too.
    const held = new Set(mine.map((answer) => answer.id));
    for (const theirs of read.answers)
      if (!held.has(theirs.id) && unfinished(theirs.status))
        answers.push({
          id: theirs.id,
          replyThreadsId: theirs.replyThreadsId,
          text: theirs.text,
          translation: null,
          state: theirs.status as DailyAnswerState,
          errorCode: theirs.errorCode,
          postedBefore: false,
        });
    // A posted answer shows as the persona's reply until a fetch stores it (2026-11-21); one with
    // no number yet is that stored reply when the same text stands under the same reply.
    const stored = read.replies;
    const posted = read.answers.filter(
      (answer) =>
        answer.status === 'published' &&
        !(answer.threadsId
          ? stored.some((reply) => reply.threadsId === answer.threadsId)
          : stored.some(
              (reply) =>
                reply.ownedByMe &&
                reply.parentThreadsId === answer.replyThreadsId &&
                reply.text.trim() === answer.text.trim(),
            )),
    );
    return {
      postId,
      fetchedAt: read.fetchedAt,
      rootThreadsId: read.rootThreadsId,
      replies: [
        ...stored.map(({ permalink, ...reply }) => ({
          ...reply,
          translation:
            notes.find((note) => note.threadsId === reply.threadsId && note.text === reply.text)
              ?.translation ?? null,
          hasLink: permalink !== null,
        })),
        ...posted.map((answer) => ({
          threadsId: answer.threadsId ?? answer.id,
          parentThreadsId: answer.replyThreadsId,
          username: '',
          text: answer.text,
          translation: null,
          mediaType: 'TEXT_POST',
          hasLink: false,
          ownedByMe: true,
          postedAt: answer.publishedAt ?? answer.createdAt,
          fromAnswer: true,
        })),
      ],
      answers,
    };
  }
  /** The replies last read for this post and the signed-in user, if any. */
  private read(context: ServiceBusinessContext, postId: string): ThreadRead | null {
    const last = this.reads.get(postId);
    return last && last.scope === JSON.stringify(this.scope(context)) ? last.read : null;
  }
  /**
   * Runs one action of the replies window and answers with the thread of the post as last read,
   * also after a failure, so a lost answer shows at once. `postId` is null for malformed input.
   */
  private async withThread(
    postId: string | null,
    action: (context: ServiceBusinessContext) => Promise<DailyPartition>,
    write = false,
  ): Promise<DailyRepliesResult> {
    let thread: DailyReplyThread | null = null;
    const seen = (context: ServiceBusinessContext, partition: DailyPartition) => {
      const read = postId ? this.read(context, postId) : null;
      thread = read && postId ? DailyController.thread(postId, partition, read) : null;
    };
    const result = await (write ? this.mutate(action, seen) : this.respond(action, seen));
    return { ...result, thread };
  }
  /**
   * Brings this PC's answers of a post in line with what the server said (2026-11-21): one on
   * Threads is forgotten, one cancelled there is a draft again under a new id, and one the server
   * holds unfinished is sent with the server's text, also a draft or an unconfirmed send whose
   * first request arrived late. Says whether anything changed.
   */
  private static settle(partition: DailyPartition, postId: string, read: ThreadRead): boolean {
    let changed = false;
    const kept: StoredDailyAnswer[] = [];
    for (const answer of partition.answers ?? []) {
      const theirs =
        answer.postId === postId ? read.answers.find((item) => item.id === answer.id) : undefined;
      if (!theirs) kept.push(answer);
      else if (theirs.status === 'published') changed = true;
      else if (theirs.status === 'cancelled') {
        if (answer.send) {
          DailyController.reopen(answer);
          changed = true;
        }
        kept.push(answer);
      } else {
        if (!answer.send?.confirmed || answer.text !== theirs.text) changed = true;
        // The Korean it was written from described the text the user changed.
        if (answer.text !== theirs.text) answer.translation = null;
        answer.text = theirs.text;
        answer.send = { confirmed: true };
        kept.push(answer);
      }
    }
    if (changed) partition.answers = kept;
    return changed;
  }
  /** A cancelled id cannot be sent again, so the draft it becomes gets a new one. */
  private static reopen(answer: StoredDailyAnswer) {
    answer.cancelledIds = [...(answer.cancelledIds ?? []), answer.id];
    answer.id = randomUUID();
    answer.send = null;
  }
  /**
   * Reads one post's replies and answers, the only way they are read, and settles this PC's
   * answers with them. The card's answer counts follow the read; the summary is not read again.
   */
  private async readThread(context: ServiceBusinessContext, postId: string) {
    const read = await this.serverReplies(context, postId);
    const summary = this.replySummary.get(postId);
    if (summary?.publicationId === read.publicationId) {
      const count = (status: AnswerStatus) =>
        read.answers.filter((answer) => answer.status === status).length;
      summary.answers = {
        queued: count('queued'),
        failed: count('failed'),
        unknown: count('unknown'),
      };
    }
    const scope = this.scope(context);
    const before = await this.options.store.read(scope);
    if (!DailyController.settle(structuredClone(before), postId, read))
      return { partition: before, read };
    this.assert(context);
    const partition = await this.options.store.update(scope, (stored) => {
      DailyController.settle(stored, postId, read);
      return stored;
    });
    return { partition, read };
  }
  /** The read after a change: a failure keeps what was last read, the change is already saved. */
  private async readAfterWork(context: ServiceBusinessContext, postId: string) {
    try {
      return (await this.readThread(context, postId)).partition;
    } catch (error) {
      this.assert(context);
      if (error instanceof ServiceApiError && error.code === 'AUTH_REQUIRED') throw error;
      return this.options.store.read(this.scope(context));
    }
  }
  /** Writes one server verdict into the stored post. The post may have changed meanwhile. */
  private static apply(post: StoredDailyPost, requestId: string | null, verdict: Verdict) {
    if (verdict.kind === 'published') {
      post.published = { sentAt: verdict.sentAt };
      post.send = null;
      post.sentBefore = false;
      return;
    }
    if (!post.send || post.send.request.requestId !== requestId) return;
    if (verdict.kind === 'draft') {
      post.send = null;
      post.sentBefore = true;
    } else if (verdict.kind === 'waiting' && verdict.note !== 'unconfirmed') {
      post.send.confirmed = true;
      post.send.sentAt = verdict.sentAt;
    }
  }
  private remember(post: StoredDailyPost, verdict: Verdict) {
    if (verdict.kind === 'waiting' && post.send)
      this.remote.set(post.id, {
        requestId: post.send.request.requestId,
        note: verdict.note,
        started: verdict.started,
      });
    else if (verdict.kind !== 'unchanged') this.remote.delete(post.id);
  }
  /**
   * The post is already on Threads through another send, so the send this PC still holds is
   * withdrawn. Best effort: if the phone has started it too, nothing here can stop it.
   */
  private async withdraw(context: ServiceBusinessContext, verdict: Verdict) {
    if (verdict.kind !== 'published' || !verdict.leftover) return;
    const { requestId, row } = verdict.leftover;
    try {
      if (row) await this.request(context, 'recall', row.id, { expectedVersion: row.version });
      else await this.request(context, 'cancel-request', requestId, {});
    } catch (error) {
      if (!(error instanceof ServiceApiError) || error.status < 400 || error.status >= 500)
        throw error;
    }
  }
  /** Asks the server about every post whose outcome is still open. */
  private async refresh(context: ServiceBusinessContext): Promise<DailyPartition> {
    const scope = this.scope(context);
    const before = await this.options.store.read(scope);
    const open = before.posts.filter((post) => !post.published && (post.send || post.sentBefore));
    const verdicts: { id: string; requestId: string | null; verdict: Verdict }[] = [];
    for (const post of open) {
      const verdict = dailyVerdict(post, await this.list(context, post.id));
      await this.withdraw(context, verdict);
      this.remember(post, verdict);
      verdicts.push({ id: post.id, requestId: post.send?.request.requestId ?? null, verdict });
    }
    if (!verdicts.some((item) => item.verdict.kind !== 'unchanged')) return before;
    this.assert(context);
    return this.options.store.update(scope, (partition) => {
      for (const item of verdicts) {
        const post = partition.posts.find((candidate) => candidate.id === item.id);
        if (post && !post.published) DailyController.apply(post, item.requestId, item.verdict);
      }
      return partition;
    });
  }
  /** Runs one action and always answers with the best view that can still be read. */
  private async respond(
    action: (context: ServiceBusinessContext) => Promise<DailyPartition>,
    seen?: (context: ServiceBusinessContext, partition: DailyPartition) => void,
  ): Promise<DailyResult> {
    let context: ServiceBusinessContext | undefined;
    try {
      context = await this.options.client.getBusinessContext();
      const partition = await action(context);
      seen?.(context, partition);
      return { status: 'ok', view: this.view(partition), problem: null };
    } catch (error) {
      let view = EMPTY;
      if (context)
        try {
          this.assert(context);
          const partition = await this.options.store.read(this.scope(context));
          seen?.(context, partition);
          view = this.view(partition);
        } catch {
          /* No data is shown after an auth change or when the file cannot be read. */
        }
      return { status: 'error', view, problem: safeProblem(error) };
    }
  }
  private mutate(
    action: (context: ServiceBusinessContext) => Promise<DailyPartition>,
    seen?: (context: ServiceBusinessContext, partition: DailyPartition) => void,
  ) {
    if (this.mutating)
      return this.respond(() => fail('daily_busy', '진행 중인 작업이 끝난 뒤 시도하세요.'), seen);
    this.mutating = true;
    return this.respond(async (context) => {
      // A sync that is under way finishes first, so the two never write the file at once.
      await this.syncing?.catch(() => {});
      return action(context);
    }, seen).finally(() => {
      this.mutating = false;
    });
  }

  state(): Promise<DailyResult> {
    return this.respond(async (context) => {
      // A change in progress has the file; this read then shows what is stored.
      if (!this.mutating) {
        this.syncing ??= this.sync(context).finally(() => {
          this.syncing = null;
        });
        await this.syncing;
      }
      const partition = await this.refresh(context);
      await this.readReplySummary(context);
      return partition;
    });
  }

  /** The replies of one published post, read from the server when its window opens or after work. */
  replies(input: unknown): Promise<DailyRepliesResult> {
    if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
      return this.withThread(null, invalid);
    const postId = input.postId;
    return this.withThread(
      postId,
      async (context) => (await this.readThread(context, postId)).partition,
    );
  }

  /**
   * Writes in Korean the replies of one post that have none, in one ChatGPT call of up to 4,000
   * characters; the rest waits for the next press. Long-running like `generate`.
   */
  async translateReplies(input: unknown): Promise<DailyRepliesResult> {
    if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
      return this.withThread(null, invalid);
    const postId = input.postId;
    if (this.generating)
      return this.withThread(postId, () =>
        fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'),
      );
    this.translatingRepliesPostId = postId;
    try {
      return await this.withThread(postId, async (context) => {
        const scope = this.scope(context);
        let read: ThreadRead;
        let batch: DailyReply[];
        let renderings: { id: string; korean: string }[];
        try {
          const before = await this.options.store.read(scope);
          const post = before.posts.find((item) => item.id === postId);
          if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
          const persona = before.personas.find((p) => p.id === post.personaId);
          if (!persona || persona.language === 'ko') return invalid();
          const settled = await this.readThread(context, postId);
          read = settled.read;
          batch = dailyReplyBatch(DailyController.thread(postId, settled.partition, read).replies);
          if (!batch.length) fail('daily_replies_translated', '한국어 뜻을 만들 댓글이 없습니다.');
          renderings = await this.options.translateReplies(
            persona,
            post.text,
            batch.map((reply) => ({ id: reply.threadsId, text: reply.text })),
          );
        } finally {
          // Every view built from here on, for success or failure, shows the work as over.
          this.translatingRepliesPostId = null;
        }
        this.assert(context);
        if (!renderings.every((item) => validDailyTranslation(item.korean)))
          fail('daily_generation', '한국어 뜻의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return this.options.store.update(scope, (partition) => {
          // A post deleted meanwhile keeps no renderings.
          if (!partition.posts.some((post) => post.id === postId)) return partition;
          const notes = (partition.replyNotes ??= []);
          for (const { id, korean } of renderings) {
            const reply = batch.find((item) => item.threadsId === id);
            if (!reply) continue;
            const note = { postId, threadsId: id, text: reply.text, translation: korean };
            const index = notes.findIndex(
              (item) => item.postId === postId && item.threadsId === id,
            );
            if (index >= 0) notes[index] = note;
            else notes.push(note);
          }
          return partition;
        });
      });
    } finally {
      this.translatingRepliesPostId = null;
    }
  }

  /** Opens on Threads one reply of the replies last read; no address comes from the window. */
  async openReplyLink(input: unknown): Promise<DailyLinkResult> {
    const last =
      isObject(input) && typeof input.postId === 'string'
        ? this.reads.get(input.postId)
        : undefined;
    const scope = await this.options.client
      .getBusinessContext()
      .then((context) => JSON.stringify(this.scope(context)))
      .catch(() => null);
    const url =
      isObject(input) &&
      exactKeys(input, ['postId', 'threadsId']) &&
      last &&
      last.scope === scope &&
      typeof input.threadsId === 'string'
        ? (last.read.replies.find((reply) => reply.threadsId === input.threadsId)?.permalink ??
          undefined)
        : undefined;
    if (!url || !threadsLink(url))
      return {
        status: 'error',
        problem: {
          code: 'link_invalid',
          message: 'Threads 링크를 열 수 없습니다. 댓글 창을 다시 열어 주세요.',
        },
      };
    try {
      await this.options.openExternal(url);
      return { status: 'ok', problem: null };
    } catch {
      return {
        status: 'error',
        problem: {
          code: 'link_open_failed',
          message: '브라우저에서 링크를 열지 못했습니다. 기본 브라우저 설정을 확인하세요.',
        },
      };
    }
  }

  savePersona(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, [
          'name',
          'accountId',
          'language',
          'description',
          ...(input.personaId === undefined ? [] : ['personaId']),
        ]) ||
        (input.personaId !== undefined && !uuid(input.personaId)) ||
        typeof input.name !== 'string' ||
        typeof input.description !== 'string' ||
        !validId(input.accountId) ||
        !LANGUAGES.includes(input.language as CaptionLanguage)
      )
        return invalid();
      const name = input.name.trim();
      const description = input.description.trim();
      if (!name || name.length > DAILY_NAME_LIMIT)
        fail('daily_persona_name', `페르소나 이름을 ${DAILY_NAME_LIMIT}자 이내로 입력하세요.`);
      if (!description || description.length > DAILY_DESCRIPTION_LIMIT)
        fail(
          'daily_persona_description',
          `페르소나 설명을 ${DAILY_DESCRIPTION_LIMIT}자 이내로 입력하세요.`,
        );
      const accountId = input.accountId;
      const language = input.language as CaptionLanguage;
      const personaId = input.personaId as string | undefined;
      const accounts = await this.accounts(context);
      if (!accounts.some((account) => account.id === accountId))
        fail('daily_account', '본인이 등록한 게시 계정을 선택하세요.');
      const scope = this.scope(context);
      /** The rules this PC keeps; returns the stored persona when one is being changed. */
      const allowed = (partition: DailyPartition) => {
        if (partition.personas.some((p) => p.accountId === accountId && p.id !== personaId))
          fail('daily_account_taken', '다른 페르소나가 이미 쓰고 있는 계정입니다.');
        if (!personaId) return null;
        const persona = partition.personas.find((p) => p.id === personaId);
        if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        if (
          persona.accountId !== accountId &&
          partition.posts.some((post) => post.personaId === personaId) &&
          accounts.some((account) => account.id === persona.accountId)
        )
          fail('daily_account_locked', '글이 있는 페르소나는 연동 계정을 바꿀 수 없습니다.');
        return persona;
      };
      const stored = allowed(await this.options.store.read(scope));
      const id = stored?.id ?? randomUUID();
      const createdAt = stored?.createdAt ?? this.now();
      const fields = { name, accountId, language, description };
      // The server first, then this PC: the phone must never lag behind what the board shows.
      let synced = true;
      try {
        const create = () =>
          this.personas(context, 'create', undefined, { id, ...fields, createdAt });
        if (!stored) await create();
        else
          await this.personas(context, 'update', id, fields).catch((error) =>
            error instanceof ServiceApiError && error.code === 'PERSONA_NOT_FOUND'
              ? create()
              : Promise.reject(error),
          );
      } catch (error) {
        if (!noPersonaStore(error) || stored?.synced === true) {
          // The answer may have been lost after the server saved it; show what is really there.
          await this.sync(context).catch(() => {});
          throw error;
        }
        synced = false;
      }
      return this.options.store.update(scope, (partition) => {
        const persona = allowed(partition);
        if (persona) Object.assign(persona, fields, { synced });
        else partition.personas.push({ id, ...fields, createdAt, synced });
        return partition;
      });
    });
  }

  deletePersona(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['personaId']) || !uuid(input.personaId))
        return invalid();
      const personaId = input.personaId;
      if (this.generatingPersonaId === personaId)
        fail('daily_busy', '글 생성이 끝난 뒤 삭제하세요.');
      const scope = this.scope(context);
      const allowed = (partition: DailyPartition) => {
        const persona = partition.personas.find((p) => p.id === personaId);
        if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        if (partition.posts.some((post) => post.personaId === personaId && post.send))
          fail('daily_persona_waiting', '휴대폰 대기 중인 글을 먼저 취소하세요.');
        const posts = new Set(
          partition.posts.filter((post) => post.personaId === personaId).map((post) => post.id),
        );
        if ((partition.answers ?? []).some((answer) => answer.send && posts.has(answer.postId)))
          fail('daily_persona_answers', '답글을 먼저 취소하거나 올려 주세요.');
        return persona;
      };
      const stored = allowed(await this.options.store.read(scope));
      // The server first: a persona left only there would come back at the next sync anyway.
      await this.personas(context, 'delete', personaId).catch((error) =>
        noPersonaStore(error) && stored.synced !== true ? undefined : Promise.reject(error),
      );
      return this.options.store.update(scope, (partition) => {
        allowed(partition);
        partition.personas = partition.personas.filter((p) => p.id !== personaId);
        partition.posts = partition.posts.filter((post) => post.personaId !== personaId);
        // The drafts and renderings of its posts go with them.
        const posts = new Set(partition.posts.map((post) => post.id));
        if (partition.answers)
          partition.answers = partition.answers.filter((answer) => posts.has(answer.postId));
        if (partition.replyNotes)
          partition.replyNotes = partition.replyNotes.filter((note) => posts.has(note.postId));
        return partition;
      });
    });
  }

  /**
   * The persona bound to one of the user's accounts, or null. Read for a caption or a comment
   * written as that persona; a file that cannot be read throws rather than reading as "none".
   */
  async persona(accountId: string): Promise<DailyPersona | null> {
    const context = await this.options.client.getBusinessContext();
    const partition = await this.options.store.read(this.scope(context));
    this.assert(context);
    return partition.personas.find((persona) => persona.accountId === accountId) ?? null;
  }

  /** Long-running, so it does not hold the mutation lock. One generation at a time. */
  async generate(input: unknown): Promise<DailyResult> {
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    if (!isObject(input) || !exactKeys(input, ['personaId']) || !uuid(input.personaId))
      return this.respond(invalid);
    const personaId = input.personaId;
    this.generatingPersonaId = personaId;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let drafts: DailyDraft[];
        try {
          const before = await this.options.store.read(scope);
          const persona = before.personas.find((p) => p.id === personaId);
          if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          const recent = before.posts
            .filter((post) => post.personaId === personaId)
            .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
            .slice(0, RECENT_POSTS)
            .map((post) => post.text);
          drafts = await this.options.generate(persona, recent, localDate(new Date(this.now())));
        } finally {
          // Every view built from here on, for success or failure, shows the work as over.
          this.generatingPersonaId = null;
        }
        this.assert(context);
        if (
          !drafts.length ||
          !drafts.every(
            (draft) =>
              validDailyText(draft.text) &&
              (draft.translation === null || validDailyTranslation(draft.translation)),
          )
        )
          fail('daily_generation', '생성된 글의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        const createdAt = this.now();
        return this.options.store.update(scope, (partition) => {
          if (!partition.personas.some((p) => p.id === personaId))
            fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          for (const draft of drafts)
            partition.posts.push({
              id: randomUUID(),
              personaId,
              text: draft.text,
              translation: draft.translation,
              createdAt,
              send: null,
              sentBefore: false,
              published: null,
            });
          return partition;
        });
      });
    } finally {
      this.generatingPersonaId = null;
    }
  }

  /**
   * Adds a draft the user wrote. A Korean draft for a persona of another language is written in
   * that language first (long-running like `generate`) and kept as the post's Korean rendering.
   */
  async addPost(input: unknown): Promise<DailyResult> {
    if (
      !isObject(input) ||
      !exactKeys(input, ['personaId', 'text', 'fromKorean']) ||
      !uuid(input.personaId) ||
      typeof input.text !== 'string' ||
      typeof input.fromKorean !== 'boolean'
    )
      return this.respond(invalid);
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    const personaId = input.personaId;
    const written = input.text.trim();
    const add = (scope: DailyScope, text: string, translation: string | null) => {
      const createdAt = this.now();
      return this.options.store.update(scope, (partition) => {
        if (!partition.personas.some((p) => p.id === personaId))
          fail('daily_persona', '페르소나를 찾을 수 없습니다.');
        partition.posts.push({
          id: randomUUID(),
          personaId,
          text,
          translation,
          createdAt,
          send: null,
          sentBefore: false,
          published: null,
        });
        return partition;
      });
    };
    if (!input.fromKorean)
      return this.mutate(async (context) => {
        if (!validDailyText(written)) fail('daily_text', '본문은 1~500자로 작성하세요.');
        return add(this.scope(context), written, null);
      });
    this.composing = true;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let text: string;
        try {
          if (!validDailyText(written)) fail('daily_text', '본문은 1~500자로 작성하세요.');
          const before = await this.options.store.read(scope);
          const persona = before.personas.find((p) => p.id === personaId);
          if (!persona) return fail('daily_persona', '페르소나를 찾을 수 없습니다.');
          if (persona.language === 'ko') return invalid();
          const limit = DAILY_KOREAN_DRAFT_LIMIT[persona.language];
          if (dailyTextLength(written) > limit)
            fail('daily_text', `한국어 본문은 ${limit}자까지 쓸 수 있습니다.`);
          text = await this.options.compose(persona, written);
        } finally {
          this.composing = false;
        }
        this.assert(context);
        if (!validDailyText(text))
          fail('daily_generation', '바꾼 글의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return add(scope, text, written);
      });
    } finally {
      this.composing = false;
    }
  }

  savePost(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, ['postId', 'text']) ||
        !uuid(input.postId) ||
        typeof input.text !== 'string'
      )
        return invalid();
      // Nothing is edited while ChatGPT writes; the board does not open the editor either.
      if (this.generating) fail('daily_busy', '글 생성이 끝난 뒤 수정하세요.');
      const text = input.text.trim();
      if (!validDailyText(text)) fail('daily_text', '본문은 1~500자로 작성하세요.');
      const postId = input.postId;
      return this.options.store.update(this.scope(context), (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
        if (post.send || post.published) fail('daily_post_sent', '초안만 수정할 수 있습니다.');
        // The Korean rendering described the old text; an edited post no longer has one.
        if (post.text !== text) post.translation = null;
        post.text = text;
        return partition;
      });
    });
  }

  /**
   * Writes the Korean rendering of a post in another language: after an edit dropped the old
   * one, or for a post made before renderings existed. Long-running like `generate`.
   */
  async translatePost(input: unknown): Promise<DailyResult> {
    if (this.generating)
      return this.respond(() => fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'));
    if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
      return this.respond(invalid);
    const postId = input.postId;
    this.translatingPostId = postId;
    try {
      return await this.respond(async (context) => {
        const scope = this.scope(context);
        let text: string;
        let translation: string;
        try {
          const before = await this.options.store.read(scope);
          const post = before.posts.find((item) => item.id === postId);
          if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
          const persona = before.personas.find((p) => p.id === post.personaId);
          if (!persona || persona.language === 'ko') return invalid();
          text = post.text;
          translation = await this.options.translate(persona, text);
        } finally {
          // Every view built from here on, for success or failure, shows the work as over.
          this.translatingPostId = null;
        }
        this.assert(context);
        if (!validDailyTranslation(translation))
          fail('daily_generation', '한국어 뜻의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return this.options.store.update(scope, (partition) => {
          const post = partition.posts.find((item) => item.id === postId);
          // A post edited or deleted meanwhile does not get the rendering of its old text.
          if (post && post.text === text) post.translation = translation;
          return partition;
        });
      });
    } finally {
      this.translatingPostId = null;
    }
  }

  deletePost(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
        return invalid();
      const postId = input.postId;
      return this.options.store.update(this.scope(context), (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (!post) return fail('daily_post', '글을 찾을 수 없습니다.');
        if (post.send || post.published) fail('daily_post_sent', '초안만 삭제할 수 있습니다.');
        partition.posts = partition.posts.filter((item) => item.id !== postId);
        return partition;
      });
    });
  }

  send(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (!isObject(input) || !exactKeys(input, ['postId']) || !uuid(input.postId))
        return invalid();
      const postId = input.postId;
      const scope = this.scope(context);
      const before = await this.options.store.read(scope);
      const current = before.posts.find((item) => item.id === postId);
      if (!current) return fail('daily_post', '글을 찾을 수 없습니다.');
      if (current.published) fail('daily_post_sent', '이미 등록된 글입니다.');
      let request = current.send?.request;
      if (!request && current.sentBefore) {
        // The phone may have posted a cancelled send after all. Never send that post again.
        const earlier = dailyVerdict(current, await this.list(context, postId));
        if (earlier.kind === 'published') {
          this.assert(context);
          await this.options.store.update(scope, (partition) => {
            const post = partition.posts.find((item) => item.id === postId);
            if (post && !post.published) DailyController.apply(post, null, earlier);
          });
          fail(
            'daily_post_sent',
            '취소했던 전송이 이미 Threads에 등록되어 다시 보내지 않았습니다.',
          );
        }
      }
      if (!request) {
        const persona = before.personas.find((p) => p.id === current.personaId);
        const account = (await this.accounts(context)).find((a) => a.id === persona?.accountId);
        if (!persona || !account)
          return fail(
            'daily_account',
            '연동된 게시 계정을 찾을 수 없습니다. 페르소나 설정에서 계정을 다시 연동하세요.',
          );
        const created: PublicationRequest = {
          requestId: randomUUID(),
          accountId: account.id,
          expectedLifecycleVersion: account.lifecycleVersion ?? 1,
          expectedOwnershipVersion: account.ownershipVersion ?? 1,
          source: {
            libraryId: DAILY_LIBRARY_ID,
            postKey: postId,
            draftCreatedAt: this.now(),
            draftRevision: 1,
            commentUpdatedAt: null,
          },
          caption: current.text,
          comment: null,
          media: [],
        };
        request = created;
        // The whole request is saved before the network call so a retry can repeat it exactly.
        this.assert(context);
        await this.options.store.update(scope, (partition) => {
          const post = partition.posts.find((item) => item.id === postId);
          if (!post || post.send || post.published || post.text !== created.caption)
            fail('daily_post_changed', '보내는 중 글이 변경되었습니다. 다시 확인하세요.');
          post!.send = { request: created, confirmed: false, sentAt: null };
        });
      }
      const sent = request;
      const publication = parsePublicationResponse(
        await this.request(context, 'create', undefined, sent),
        0,
      );
      if (
        publication.requestId !== sent.requestId ||
        publication.accountId !== sent.accountId ||
        publication.caption !== sent.caption ||
        JSON.stringify(publication.source) !== JSON.stringify(sent.source) ||
        publication.comment ||
        publication.media.length
      )
        fail('INVALID_RESPONSE', '전송 요청과 서버에 저장된 글이 다릅니다.');
      this.assert(context);
      await this.options.store.update(scope, (partition) => {
        const post = partition.posts.find((item) => item.id === postId);
        if (post?.send?.request.requestId === sent.requestId) {
          post.send.confirmed = true;
          post.send.sentAt = publication.sentAt;
        }
      });
      return this.refresh(context);
    });
  }

  cancelSend(input: unknown): Promise<DailyResult> {
    return this.mutate(async (context) => {
      if (
        !isObject(input) ||
        !exactKeys(input, ['postId', ...(input.abandon === undefined ? [] : ['abandon'])]) ||
        !uuid(input.postId) ||
        (input.abandon !== undefined && input.abandon !== true)
      )
        return invalid();
      const postId = input.postId;
      const scope = this.scope(context);
      const before = await this.options.store.read(scope);
      const current = before.posts.find((item) => item.id === postId);
      if (!current?.send) return fail('daily_post', '취소할 전송을 찾을 수 없습니다.');
      const requestId = current.send.request.requestId;
      const rows = await this.list(context, postId);
      const verdict = dailyVerdict(current, rows);
      const finish = async (result: Verdict, problem?: ViewError) => {
        await this.withdraw(context, result);
        this.remember(current, result);
        this.assert(context);
        const partition = await this.options.store.update(scope, (stored) => {
          const post = stored.posts.find((item) => item.id === postId);
          if (post && !post.published) DailyController.apply(post, requestId, result);
          return stored;
        });
        if (problem) throw problem;
        return partition;
      };
      if (verdict.kind === 'published')
        return finish(
          verdict,
          new ViewError('daily_post_sent', '이미 Threads에 등록된 글이라 취소할 수 없습니다.'),
        );
      if (verdict.kind === 'draft') return finish(verdict);
      const row = rows.find((item) => item.requestId === requestId);
      if (!row) {
        const response = await this.request(context, 'cancel-request', requestId, {});
        if (!isObject(response) || response.requestCancelled !== true)
          fail('INVALID_RESPONSE', '전송 취소 결과를 확인하지 못했습니다.');
        if (response.publication !== null) {
          const late = parsePublicationResponse(response, 0);
          if (late.status !== 'cancelled' && late.status !== 'expired')
            fail('INVALID_RESPONSE', '전송이 취소되지 않았습니다.');
        }
        return finish({ kind: 'draft' });
      }
      // The view returned with this refusal shows the post as started, so the warning can open.
      if (row.status === 'started' && input.abandon !== true)
        return finish(
          verdict,
          new ViewError(
            'daily_send_started',
            '휴대폰이 이미 등록을 시도한 글입니다. 안내를 확인한 뒤 다시 취소하세요.',
          ),
        );
      const recalled = parsePublicationResponse(
        await this.request(context, 'recall', row.id, {
          expectedVersion: row.version,
          ...(row.status === 'started' ? { abandonUnresolved: true } : {}),
        }),
        0,
      );
      if (recalled.id !== row.id || recalled.status !== 'cancelled')
        fail('INVALID_RESPONSE', '취소 결과를 확인하지 못했습니다.');
      return finish({ kind: 'draft' });
    });
  }

  /**
   * Adds the persona's answer draft to one reply of the replies last read (2026-11-21). A Korean
   * draft for a persona of another language is written in that language first (long-running like
   * `generate`) and kept as its Korean; ChatGPT is never handed the reply it answers.
   */
  async addAnswer(input: unknown): Promise<DailyRepliesResult> {
    if (
      !isObject(input) ||
      !exactKeys(input, ['postId', 'replyThreadsId', 'text', 'fromKorean']) ||
      !uuid(input.postId) ||
      !threadsId(input.replyThreadsId) ||
      typeof input.text !== 'string' ||
      typeof input.fromKorean !== 'boolean'
    )
      return this.withThread(null, invalid);
    const { postId, replyThreadsId, fromKorean } = input;
    if (this.generating)
      return this.withThread(postId, () =>
        fail('daily_busy', '진행 중인 글 생성이 끝난 뒤 시도하세요.'),
      );
    const written = input.text.trim();
    /** The rules this PC keeps; returns the persona and the publication the answer is for. */
    const allowed = (context: ServiceBusinessContext, partition: DailyPartition) => {
      const post = partition.posts.find((item) => item.id === postId);
      const persona = partition.personas.find((p) => p.id === post?.personaId);
      if (!post?.published || !persona) return fail('daily_post', '글을 찾을 수 없습니다.');
      const read = this.read(context, postId);
      const reply = read?.replies.find((item) => item.threadsId === replyThreadsId);
      if (!read || !reply)
        return fail('daily_reply', '댓글을 찾을 수 없습니다. 댓글 창을 다시 열어 주세요.');
      if (reply.ownedByMe) return invalid();
      if (
        (partition.answers ?? []).some(
          (answer) => answer.postId === postId && answer.replyThreadsId === replyThreadsId,
        ) ||
        read.answers.some(
          (answer) => answer.replyThreadsId === replyThreadsId && unfinished(answer.status),
        )
      )
        fail('daily_answer_exists', '이 댓글에는 이미 쓴 답글이 있습니다.');
      if (!validDailyText(written)) fail('daily_text', '본문은 1~500자로 작성하세요.');
      return { persona, publicationId: read.publicationId };
    };
    const add = (context: ServiceBusinessContext, text: string, translation: string | null) => {
      const createdAt = this.now();
      return this.options.store.update(this.scope(context), (partition) => {
        const { publicationId } = allowed(context, partition);
        (partition.answers ??= []).push({
          id: randomUUID(),
          postId,
          publicationId,
          replyThreadsId,
          text,
          translation,
          createdAt,
          send: null,
        });
        return partition;
      });
    };
    if (!fromKorean) return this.withThread(postId, (context) => add(context, written, null), true);
    this.composing = true;
    try {
      return await this.withThread(postId, async (context) => {
        let text: string;
        try {
          const { persona } = allowed(context, await this.options.store.read(this.scope(context)));
          if (persona.language === 'ko') return invalid();
          const limit = DAILY_KOREAN_DRAFT_LIMIT[persona.language];
          if (dailyTextLength(written) > limit)
            fail('daily_text', `한국어 본문은 ${limit}자까지 쓸 수 있습니다.`);
          text = await this.options.composeAnswer(persona, written);
        } finally {
          this.composing = false;
        }
        this.assert(context);
        if (!validDailyText(text))
          fail('daily_generation', '바꾼 답글의 형식을 확인하지 못했습니다. 다시 시도하세요.');
        return add(context, text, written);
      });
    } finally {
      this.composing = false;
    }
  }

  /** The stored answer of one post that an edit, delete, send or cancel names. */
  private static answerInput(input: unknown, more: string[] = []) {
    return isObject(input) &&
      exactKeys(input, ['postId', 'answerId', ...more]) &&
      uuid(input.postId) &&
      uuid(input.answerId)
      ? { postId: input.postId, answerId: input.answerId }
      : null;
  }
  private static draft(partition: DailyPartition, postId: string, answerId: string) {
    const answer = (partition.answers ?? []).find(
      (item) => item.id === answerId && item.postId === postId,
    );
    if (!answer)
      return fail('daily_answer', '답글을 찾을 수 없습니다. 댓글 창을 다시 열어 주세요.');
    if (answer.send) fail('daily_answer_sent', '초안만 수정하거나 삭제할 수 있습니다.');
    return answer;
  }

  saveAnswer(input: unknown): Promise<DailyRepliesResult> {
    const names = DailyController.answerInput(input, ['text']);
    const text = isObject(input) && typeof input.text === 'string' ? input.text.trim() : null;
    if (!names || text === null) return this.withThread(null, invalid);
    const { postId, answerId } = names;
    return this.withThread(
      postId,
      async (context) => {
        // Nothing is edited while ChatGPT writes; the window does not open the editor either.
        if (this.generating) fail('daily_busy', '글 생성이 끝난 뒤 수정하세요.');
        if (!validDailyText(text)) fail('daily_text', '본문은 1~500자로 작성하세요.');
        return this.options.store.update(this.scope(context), (partition) => {
          const answer = DailyController.draft(partition, postId, answerId);
          // The Korean it was written from described the old text.
          if (answer.text !== text) answer.translation = null;
          answer.text = text;
          return partition;
        });
      },
      true,
    );
  }

  deleteAnswer(input: unknown): Promise<DailyRepliesResult> {
    const names = DailyController.answerInput(input);
    if (!names) return this.withThread(null, invalid);
    const { postId, answerId } = names;
    return this.withThread(
      postId,
      (context) =>
        this.options.store.update(this.scope(context), (partition) => {
          DailyController.draft(partition, postId, answerId);
          partition.answers = partition.answers!.filter((answer) => answer.id !== answerId);
          return partition;
        }),
      true,
    );
  }

  /**
   * Sends answers of one post to the phone one at a time, in the order they were written: drafts,
   * or an answer whose send was not confirmed, repeated under the same id. Each send is written
   * down before its call; the first one that fails stops the rest.
   */
  sendAnswers(input: unknown): Promise<DailyRepliesResult> {
    if (
      !isObject(input) ||
      !exactKeys(input, ['postId', 'answerIds']) ||
      !uuid(input.postId) ||
      !Array.isArray(input.answerIds) ||
      !input.answerIds.length ||
      !input.answerIds.every(uuid) ||
      new Set(input.answerIds).size !== input.answerIds.length
    )
      return this.withThread(null, invalid);
    const postId = input.postId;
    const ids = input.answerIds as string[];
    return this.withThread(
      postId,
      async (context) => {
        const scope = this.scope(context);
        const before = await this.options.store.read(scope);
        const chosen = (before.answers ?? [])
          .filter((answer) => answer.postId === postId && ids.includes(answer.id))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (chosen.length !== ids.length)
          fail('daily_answer', '답글을 찾을 수 없습니다. 댓글 창을 다시 열어 주세요.');
        const change = (answerId: string, edit: (answer: StoredDailyAnswer) => void) => {
          this.assert(context);
          return this.options.store.update(scope, (partition) => {
            const answer = partition.answers?.find((item) => item.id === answerId);
            if (answer) edit(answer);
          });
        };
        for (const answer of chosen) {
          if (!answer.send)
            await change(answer.id, (stored) => {
              if (stored.send || stored.text !== answer.text)
                fail('daily_answer_changed', '보내는 중 답글이 변경되었습니다. 다시 확인하세요.');
              stored.send = { confirmed: false };
            });
          let response: unknown;
          try {
            this.assert(context);
            response = await this.options.client.replyRequest(
              context,
              'answer',
              answer.publicationId,
              { id: answer.id, replyThreadsId: answer.replyThreadsId, text: answer.text },
            );
          } catch (error) {
            if (refusedAnswer(error))
              await change(answer.id, (stored) => {
                if (stored.send && !stored.send.confirmed) stored.send = null;
              });
            throw error;
          }
          this.assert(context);
          const saved = serverAnswer(isObject(response) ? response.answer : null);
          if (
            !saved ||
            saved.id !== answer.id ||
            saved.replyThreadsId !== answer.replyThreadsId ||
            saved.text !== answer.text
          )
            fail('INVALID_RESPONSE', '보낸 답글과 서버에 저장된 답글이 다릅니다.');
          await change(answer.id, (stored) => {
            if (stored.send) stored.send.confirmed = true;
          });
        }
        return this.readAfterWork(context, postId);
      },
      true,
    );
  }

  /**
   * Takes an answer back from the phone (2026-11-21). One the server cancelled becomes a draft again
   * under a new id; one it never received becomes a draft under its own. An answer the phone tried
   * already is left to the phone, and the window then shows it as it is.
   */
  cancelAnswer(input: unknown): Promise<DailyRepliesResult> {
    const names = DailyController.answerInput(input);
    if (!names) return this.withThread(null, invalid);
    const { postId, answerId } = names;
    return this.withThread(
      postId,
      async (context) => {
        const scope = this.scope(context);
        const before = await this.options.store.read(scope);
        const mine = (before.answers ?? []).find(
          (answer) => answer.id === answerId && answer.postId === postId && answer.send,
        );
        const theirs = this.read(context, postId)?.answers.find(
          (answer) => answer.id === answerId && unfinished(answer.status),
        );
        if (!mine && !theirs) fail('daily_answer', '취소할 답글을 찾을 수 없습니다.');
        /** The server answered that it cancelled the id; false when it never received it. */
        let cancelled = false;
        try {
          this.assert(context);
          const response = await this.options.client.replyRequest(context, 'cancel', answerId);
          this.assert(context);
          const answer = serverAnswer(isObject(response) ? response.answer : null);
          if (answer?.id !== answerId || answer.status !== 'cancelled')
            fail('INVALID_RESPONSE', '취소 결과를 확인하지 못했습니다.');
          cancelled = true;
        } catch (error) {
          this.assert(context);
          // The server never recorded this send of this PC; nothing there can be posted.
          const neverReceived =
            mine && error instanceof ServiceApiError && error.code === 'NOT_FOUND';
          if (!neverReceived) {
            if (error instanceof ServiceApiError && error.code === 'ANSWER_NOT_CANCELLABLE')
              await this.readAfterWork(context, postId);
            throw error;
          }
        }
        if (mine)
          await this.options.store.update(scope, (partition) => {
            const answer = partition.answers?.find((item) => item.id === answerId);
            if (!answer?.send) return;
            // Only an id the server cancelled is spent. One it never received stays: a first
            // request that arrives late is then the same answer, never a second one.
            if (cancelled) DailyController.reopen(answer);
            else answer.send = null;
          });
        return this.readAfterWork(context, postId);
      },
      true,
    );
  }
}
