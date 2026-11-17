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
}

export interface DailyResult {
  status: 'ok' | 'error';
  view: DailyView;
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
}

export const dailyTextLength = (text: string) => [...text].length;
