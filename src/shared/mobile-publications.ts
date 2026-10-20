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
