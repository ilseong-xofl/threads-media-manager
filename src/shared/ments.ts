import type { Problem } from './contracts';
import { DAILY_TEXT_LIMIT } from './daily';

/** Brand and product names, and ment titles (2026-11-24), counted in code points. */
export const MENT_NAME_LIMIT = 40;
export const MENT_TITLE_LIMIT = 40;
/** A ment goes into a post, so it keeps the Threads text limit. */
export const MENT_BODY_LIMIT = DAILY_TEXT_LIMIT;

/** A ment (멘트): saved ad copy with a title, kept under one product of a brand. */
export interface Ment {
  id: string;
  title: string;
  body: string;
}
export interface MentProduct {
  id: string;
  name: string;
  /** In the order they were made. */
  ments: Ment[];
}
export interface MentBrand {
  id: string;
  name: string;
  products: MentProduct[];
}
/** The signed-in employee's own brands, products and ments, as the server keeps them. */
export interface MentCatalog {
  brands: MentBrand[];
}

export type MentKind = 'brand' | 'product' | 'ment';
/** Creates the item with this id, or changes the one that has it. The PC chooses new ids. */
export type SaveMentInput =
  | { kind: 'brand'; id: string; name: string }
  | { kind: 'product'; id: string; brandId: string; name: string }
  | { kind: 'ment'; id: string; productId: string; title: string; body: string };
/** Deletes the item and everything under it. */
export interface DeleteMentInput {
  kind: MentKind;
  id: string;
}
/**
 * `catalog` is null only when nothing could be read. After a failed save or delete it is the
 * catalog read again, so the screen shows what the server has.
 */
export interface MentResult {
  status: 'ok' | 'error';
  catalog: MentCatalog | null;
  problem: Problem | null;
}

export interface MentMethods {
  getMents(): Promise<MentResult>;
  saveMent(input: SaveMentInput): Promise<MentResult>;
  deleteMent(input: DeleteMentInput): Promise<MentResult>;
}

export const mentLength = (text: string) => [...text].length;
