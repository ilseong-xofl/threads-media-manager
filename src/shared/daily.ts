import type { CaptionLanguage, Problem } from './contracts';

export const DAILY_NAME_LIMIT = 40;
export const DAILY_DESCRIPTION_LIMIT = 2000;
/** Threads text limit, counted in code points like the existing publication checks. */
export const DAILY_TEXT_LIMIT = 500;

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
  createdAt: string;
  state: DailyPostState;
  /** Waiting posts only. null means the phone has not started it. */
  note: DailyWaitingNote | null;
  /** Waiting posts only. The phone already tried, so cancelling must warn first. */
  started: boolean;
  /** When the server accepted the send; null for drafts and unconfirmed sends. */
  sentAt: string | null;
}

export interface DailyView {
  personas: DailyPersona[];
  posts: DailyPost[];
  /** The persona whose posts are being generated right now, if any. */
  generatingPersonaId: string | null;
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
  saveDailyPost(input: SaveDailyPostInput): Promise<DailyResult>;
  deleteDailyPost(input: DailyPostInput): Promise<DailyResult>;
  /** Sends a draft to the phone, or repeats an unconfirmed send unchanged. */
  sendDailyPost(input: DailyPostInput): Promise<DailyResult>;
  /** Takes a sent post back to a draft. */
  cancelDailySend(input: CancelDailySendInput): Promise<DailyResult>;
}

export const dailyTextLength = (text: string) => [...text].length;
