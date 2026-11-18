/** Public publication metadata only. File paths, signed URLs and tokens stay in main. */
export interface MobilePublicationSource {
  libraryId: string;
  postKey: string;
  draftCreatedAt: string;
  draftRevision: number;
  commentUpdatedAt: string | null;
}
export interface MobilePublicationMedia {
  id: string;
  ordinal: number;
  kind: 'image' | 'video';
  contentType: 'image/jpeg' | 'image/png' | 'video/mp4' | 'video/quicktime';
  size: number;
  sha256: string;
}
export interface MobilePublication {
  id: string;
  requestId: string;
  version: number;
  accountId: string;
  source: MobilePublicationSource;
  status: 'uploading' | 'ready' | 'cancelled' | 'expired' | 'started' | 'published';
  caption: string;
  comment: { caption: string; link: string } | null;
  media: MobilePublicationMedia[];
  sentAt: string | null;
  deadlineAt: string | null;
  rootStatus: string;
  commentStatus: string;
}
export interface PendingMobilePublication {
  requestId: string;
  accountId: string;
  source: MobilePublicationSource;
}
export interface MobilePublicationsResult {
  status: 'ok' | 'error';
  publications: MobilePublication[];
  pending: PendingMobilePublication[];
  problem: { code: string; message: string } | null;
}
/** A registered draft whose root reached Threads from a phone; drives the card badges. */
export interface MobilePublicationStatus {
  postKey: string;
  draftCreatedAt: string;
  commentPublished: boolean;
}
export interface MobilePublicationStatusesResult {
  status: 'ok' | 'error';
  statuses: MobilePublicationStatus[];
  problem: { code: string; message: string } | null;
}
export interface SendMobilePublicationInput {
  postKey: string;
  expectedRevision: number;
  expectedDraftCreatedAt: string;
  expectedCommentUpdatedAt: string | null;
  accountId: string;
}
export interface RecallMobilePublicationInput {
  publicationId: string;
  expectedVersion: number;
  abandonUnresolved?: true;
}
export interface MobilePublicationMethods {
  getMobilePublications(input: { postKey: string }): Promise<MobilePublicationsResult>;
  sendMobilePublication(input: SendMobilePublicationInput): Promise<MobilePublicationsResult>;
  retryMobilePublication(input: { requestId: string }): Promise<MobilePublicationsResult>;
  cancelPendingMobilePublication(input: { requestId: string }): Promise<MobilePublicationsResult>;
  recallMobilePublication(input: RecallMobilePublicationInput): Promise<MobilePublicationsResult>;
}

/**
 * The account a registered draft is bound to by what was already sent for it (2026-11-18), or
 * null when nothing sent holds it. Only history of the same registration counts
 * (`draftCreatedAt`): a post deleted and registered again is a new one.
 *
 * It holds while a send is pending on this PC, while a copy is uploading, waiting or taken by a
 * phone, and whenever the root may have reached Threads (sending, unknown, uncertain, published)
 * even if the copy itself was cancelled afterwards. A root that was never started or failed on a
 * cancelled or expired copy holds nothing.
 */
export function lockedPublicationAccount(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
  draftCreatedAt: string,
): string | null {
  const waiting = pending.find((item) => item.source.draftCreatedAt === draftCreatedAt);
  if (waiting) return waiting.accountId;
  const held = publications.find(
    (item) =>
      item.source.draftCreatedAt === draftCreatedAt &&
      (['uploading', 'ready', 'started', 'published'].includes(item.status) ||
        ['sending', 'unknown', 'uncertain', 'published'].includes(item.rootStatus)),
  );
  return held?.accountId ?? null;
}
