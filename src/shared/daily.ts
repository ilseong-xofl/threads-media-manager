import type { CaptionLanguage, Problem } from './contracts';

export const DAILY_NAME_LIMIT = 40;
export const DAILY_DESCRIPTION_LIMIT = 2000;
/** Threads text limit, counted in code points like the existing publication checks. */
export const DAILY_TEXT_LIMIT = 500;
/**
 * How long a Korean draft may be when it is written into the persona's language (2026-11-18).
 * English comes out about twice as long; past 200 characters the result was squeezed into terse
 * fragments to stay within a post. Japanese comes out shorter than the Korean.
 */
export const DAILY_KOREAN_DRAFT_LIMIT: Record<CaptionLanguage, number> = {
  ko: DAILY_TEXT_LIMIT,
  ja: DAILY_TEXT_LIMIT,
  en: 200,
};
export const DAILY_TRANSLATION_LIMIT = 1000;

/** One fictional author. It is bound to exactly one managed Threads account. */
export interface DailyPersona {
  id: string;
  name: string;
  /** Server id of the managed Threads account (`ManagedThreadsAccount.id`). */
  accountId: string;
  language: CaptionLanguage;
  description: string;
  createdAt: string;
}

export type DailyPostState = 'draft' | 'waiting' | 'published';
/**
 * Why a sent post is still waiting. `unconfirmed`: the server has no record of the send yet.
 * `check_phone`: the phone sent it and got no answer. `failed`: Meta refused it.
 * `expired`: the seven-day deadline passed.
 */
export type DailyWaitingNote = 'unconfirmed' | 'check_phone' | 'failed' | 'expired';

export interface DailyPost {
  id: string;
  personaId: string;
  text: string;
  /** What a post written in another language says, in Korean. Shown on this PC only, never sent. */
  translation: string | null;
  createdAt: string;
  state: DailyPostState;
  /** Waiting posts only. null means the phone has not started it. */
  note: DailyWaitingNote | null;
  /** Waiting posts only. The phone already tried, so cancelling must warn first. */
  started: boolean;
  /** When the server accepted the send; null for drafts and unconfirmed sends. */
  sentAt: string | null;
  /** Published posts whose replies the phone has fetched (2026-11-21); null otherwise. */
  replies: DailyReplySummary | null;
}

/** The server's summary of the replies of one published post. */
export interface DailyReplySummary {
  fetchedAt: string;
  /** Replies by other people; the account's own replies are not counted. */
  count: number;
}

/** One reply to a published post, as the server keeps it. No copy is stored on this PC. */
export interface DailyReply {
  threadsId: string;
  /** The post or reply this one answers; the post itself for a reply made to the post. */
  parentThreadsId: string;
  username: string;
  /** May be empty for a reply that is only an image or a video. */
  text: string;
  /** What the reply says in Korean, kept on this PC for the text it was written for. */
  translation: string | null;
  /** Meta's media_type as it came. */
  mediaType: string;
  /** The reply can be opened on Threads. */
  hasLink: boolean;
  /** Written by the persona's own account. */
  ownedByMe: boolean;
  postedAt: string;
}

/** The replies of one published post, newest first as the server sends them. */
export interface DailyReplyThread {
  postId: string;
  fetchedAt: string | null;
  rootThreadsId: string | null;
  replies: DailyReply[];
}

/** One written post as the generator returns it. */
export interface DailyDraft {
  text: string;
  translation: string | null;
}

export interface DailyView {
  personas: DailyPersona[];
  posts: DailyPost[];
  /** The persona whose posts are being generated right now, if any. */
  generatingPersonaId: string | null;
  /** The post whose Korean rendering is being written right now, if any. */
  translatingPostId: string | null;
  /** The post whose replies are being written in Korean right now, if any. */
  translatingRepliesPostId: string | null;
  /**
   * Personas the server is not known to hold (2026-11-18): the phone shows a persona only when
   * the server has it. Counts this PC's personas the last sync could not confirm or upload, and
   * server personas it could not take in because their account is used by another one here.
   */
  unsyncedPersonas: number;
}

export interface DailyResult {
  status: 'ok' | 'error';
  view: DailyView;
  problem: Problem | null;
}

export interface DailyRepliesResult extends DailyResult {
  /** The replies that were read; null when the call failed. */
  thread: DailyReplyThread | null;
}

export interface DailyReplyLinkInput {
  postId: string;
  threadsId: string;
}
export interface DailyLinkResult {
  status: 'ok' | 'error';
  problem: Problem | null;
}

export interface SaveDailyPersonaInput {
  /** Omitted when creating. */
  personaId?: string;
  name: string;
  accountId: string;
  language: CaptionLanguage;
  description: string;
}
export interface DailyPersonaInput {
  personaId: string;
}
export interface DailyPostInput {
  postId: string;
}
export interface SaveDailyPostInput {
  postId: string;
  text: string;
}
export interface AddDailyPostInput {
  personaId: string;
  text: string;
  /** The text is a Korean draft to be written in the persona's language first. */
  fromKorean: boolean;
}
export interface CancelDailySendInput {
  postId: string;
  /** Required when the phone already tried (`DailyPost.started`); the user confirmed the warning. */
  abandon?: true;
}

export interface DailyMethods {
  /** Reads local data and refreshes the server state of sent posts. */
  getDaily(): Promise<DailyResult>;
  saveDailyPersona(input: SaveDailyPersonaInput): Promise<DailyResult>;
  deleteDailyPersona(input: DailyPersonaInput): Promise<DailyResult>;
  /** Adds three drafts written for the persona. */
  generateDailyPosts(input: DailyPersonaInput): Promise<DailyResult>;
  /** Adds one draft the user wrote: as written, or from Korean into the persona's language. */
  addDailyPost(input: AddDailyPostInput): Promise<DailyResult>;
  saveDailyPost(input: SaveDailyPostInput): Promise<DailyResult>;
  /** Writes what a post in another language says in Korean, for a post that has no rendering. */
  translateDailyPost(input: DailyPostInput): Promise<DailyResult>;
  deleteDailyPost(input: DailyPostInput): Promise<DailyResult>;
  /** Sends a draft to the phone, or repeats an unconfirmed send unchanged. */
  sendDailyPost(input: DailyPostInput): Promise<DailyResult>;
  /** Takes a sent post back to a draft. */
  cancelDailySend(input: CancelDailySendInput): Promise<DailyResult>;
  /** Reads the replies of one published post from the server. */
  getDailyReplies(input: DailyPostInput): Promise<DailyRepliesResult>;
  /** Writes in Korean the replies of one post that have no rendering yet, as many as fit at once. */
  translateDailyReplies(input: DailyPostInput): Promise<DailyRepliesResult>;
  /** Opens one reply of the replies last read on Threads, in the browser. */
  openDailyReplyLink(input: DailyReplyLinkInput): Promise<DailyLinkResult>;
}

export const dailyTextLength = (text: string) => [...text].length;
