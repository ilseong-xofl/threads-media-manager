export const MEDIA_SCHEME = 'threads-media';
export const IPC = {
  capabilities: 'tmm:app:capabilities',
  current: 'tmm:collection:current',
  choose: 'tmm:collection:choose',
  refresh: 'tmm:collection:refresh',
  downloadStatus: 'tmm:download:status',
  downloadPrepare: 'tmm:download:prepare',
  downloadStart: 'tmm:download:start',
  downloadResume: 'tmm:download:resume',
  downloadRecover: 'tmm:download:recover',
  exportPost: 'tmm:post:export',
  saveMediaEdit: 'tmm:media:edit',
  deleteMedia: 'tmm:media:delete',
  recoverDeletions: 'tmm:media:delete-recover',
  savePostComment: 'tmm:post:comment',
  openPostLink: 'tmm:post:open-link',
  savePostDraft: 'tmm:post:draft',
  deletePostDraft: 'tmm:post:draft-delete',
  exportPostDraft: 'tmm:post:draft-export',
  generateCaption: 'tmm:caption:generate',
  cancelCaption: 'tmm:caption:cancel',
  generateContent: 'tmm:content:generate',
  loadContent: 'tmm:content:load',
  revealContent: 'tmm:content:reveal',
  cancelContent: 'tmm:content:cancel',
  copyContentCaption: 'tmm:content:copy-caption',
  libraryRoot: 'tmm:library:root',
  backupDatabase: 'tmm:library:backup',
  restoreDatabase: 'tmm:library:restore',
  reconnectLibrary: 'tmm:library:reconnect',
} as const;
export interface Problem {
  code: string;
  message: string;
  source?: string;
}
export interface Attachment {
  ordinal: number;
  kind: 'image' | 'video';
  addressStatus: string;
  observedAt: string | null;
  status: 'not_downloaded' | 'saved' | 'unavailable' | 'review';
  reason: string | null;
  mediaId: string | null;
  localUrl: string | null;
  aiGenerated?: boolean;
  generationId?: string;
  editType?: 'crop' | 'capture' | 'trim';
  sourceMediaId?: string;
  createdAt?: string;
}
export interface Post {
  key: string;
  account: string;
  postId: string;
  originalUrl: string;
  publishedAt: string | null;
  collectedAt: string | null;
  observedAt: string | null;
  caption: string;
  captionStatus: string;
  captionObservedAt: string | null;
  attachmentStatus: string;
  runStatus: string;
  gapStatus: string;
  downloadExcluded?: boolean;
  reasons: string[];
  source: string;
  attachments: Attachment[];
  edits?: Attachment[];
  aiImages?: Attachment[];
  comment?: PostComment;
  draft?: PostDraft;
}
export interface PostDraft {
  caption: string;
  mediaIds: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}
export interface SavePostDraftInput {
  postKey: string;
  caption: string;
  mediaIds: string[];
  expectedRevision: number | null;
}
export type PostDraftResult =
  | { status: 'saved'; draft: PostDraft; view: CollectionView }
  | { status: 'error'; problem: Problem };
export interface PostDraftActionInput {
  postKey: string;
  expectedRevision: number;
}
export type DeletePostDraftResult = MediaDeleteResult;
export type CaptionLanguage = 'en' | 'ko' | 'ja';
export interface GenerateCaptionInput {
  postKey: string;
  mediaIds: string[];
  language: CaptionLanguage;
}
export type GenerateCaptionResult =
  | { status: 'generated'; captions: [string, string, string] }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };
export interface GenerateContentInput {
  postKey: string;
  language: CaptionLanguage;
}
export interface AIContentDraft {
  id: string;
  createdAt: string;
  language: CaptionLanguage;
  sourceImageCount: number;
  analysis: string;
  concept: string;
  product: string;
  caption: string;
  imagePrompts: string[];
  images: string[];
  directory: string;
}
export type GenerateContentResult =
  | { status: 'generated'; draft: AIContentDraft }
  | { status: 'empty' }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };
export interface PostComment {
  caption: string;
  link: string;
  updatedAt: string;
}
export interface SavePostCommentInput {
  postKey: string;
  caption: string;
  link: string;
}
export type PostCommentResult =
  | { status: 'saved'; comment: PostComment; view: CollectionView }
  | { status: 'error'; problem: Problem };
export interface OpenPostLinkInput {
  postKey: string;
  kind: 'original' | 'comment';
}
export type PostLinkResult = { status: 'opened' } | { status: 'error'; problem: Problem };
export interface Snapshot {
  root: string;
  loadedAt: string;
  sourceCount: number;
  posts: Post[];
  warnings: Problem[];
  stateStatus: 'absent' | 'read_only' | 'unavailable';
}
export interface CollectionView {
  snapshot: Snapshot | null;
  error: Problem | null;
}
export interface AppCapabilities {
  aiContent: boolean;
}
export interface ThreadsMediaApi {
  capabilities(): Promise<AppCapabilities>;
  current(): Promise<CollectionView>;
  chooseFolder(): Promise<CollectionView>;
  refresh(): Promise<CollectionView>;
  downloadStatus(): Promise<DownloadView>;
  prepareDownload(account: string): Promise<DownloadView>;
  startDownload(): Promise<DownloadView>;
  resumeDownloads(): Promise<DownloadView>;
  recoverDownloads(): Promise<DownloadView>;
  libraryRoot(): Promise<string | null>;
  backupDatabase(): Promise<LibraryMaintenanceResult>;
  restoreDatabase(): Promise<LibraryMaintenanceResult>;
  reconnectLibrary(): Promise<LibraryMaintenanceResult>;
  exportPost(postKey: string): Promise<PostExportResult>;
  saveMediaEdit(input: MediaEditInput): Promise<MediaEditResult>;
  deleteMedia(input: MediaDeleteInput): Promise<MediaDeleteResult>;
  recoverDeletions(): Promise<MediaDeleteResult>;
  savePostComment(input: SavePostCommentInput): Promise<PostCommentResult>;
  openPostLink(input: OpenPostLinkInput): Promise<PostLinkResult>;
  savePostDraft(input: SavePostDraftInput): Promise<PostDraftResult>;
  deletePostDraft(input: PostDraftActionInput): Promise<DeletePostDraftResult>;
  exportPostDraft(input: PostDraftActionInput): Promise<PostExportResult>;
  generateCaption(input: GenerateCaptionInput): Promise<GenerateCaptionResult>;
  cancelCaption(): Promise<void>;
  generateContent(input: GenerateContentInput): Promise<GenerateContentResult>;
  loadContent(input: { postKey: string }): Promise<GenerateContentResult>;
  revealContent(input: { postKey: string }): Promise<PostLinkResult>;
  copyContentCaption(input: { postKey: string }): Promise<PostLinkResult>;
  cancelContent(): Promise<void>;
}

export type MediaDeleteInput =
  { kind: 'edit'; postKey: string; mediaId: string } | { kind: 'post'; postKey: string };

export type MediaDeleteResult =
  | { status: 'deleted'; view: CollectionView }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };

export type MediaEditInput =
  | {
      postKey: string;
      mediaId: string;
      kind: 'crop';
      crop: { x: number; y: number; width: number; height: number };
    }
  | { postKey: string; mediaId: string; kind: 'capture'; png: Uint8Array; time: number }
  | { postKey: string; mediaId: string; kind: 'trim'; start: number; end: number };

export type MediaEditResult =
  | { status: 'saved'; mediaId: string; view: CollectionView }
  | { status: 'error'; problem: Problem };

export type PostExportResult =
  | { status: 'saved'; fileName: string }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };

export interface DownloadTarget {
  account: string;
  postId: string;
  ordinal: number;
  kind: 'image' | 'video';
}
export type DownloadPhase =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'downloading'
  | 'validating'
  | 'waiting'
  | 'stopping'
  | 'recovering'
  | 'complete'
  | 'blocked'
  | 'error';
export interface DownloadBatch {
  totalPosts: number;
  completedPosts: number;
  totalFiles: number;
  completedFiles: number;
  totalRounds: number;
  currentRound: number;
  deferredPosts: number;
  skippedPosts?: number;
}
export interface DownloadView {
  phase: DownloadPhase;
  target: DownloadTarget | null;
  nextAllowedAt: number | null;
  problem: Problem | null;
  recoverable: boolean;
  resumable?: boolean;
  received: number;
  total: number | null;
  revision: number;
  batch?: DownloadBatch | null;
  cleanedPosts?: number;
  releasedPosts?: number;
}

export type LibraryMaintenanceOperation = 'backup' | 'restore' | 'reconnect';
export type LibraryMaintenanceResult =
  | {
      status: 'complete';
      operation: LibraryMaintenanceOperation;
      view: CollectionView;
      filePath?: string;
      automaticBackupPath?: string;
      restoreMode?: 'metadata' | 'full';
      historyReviewRequired?: boolean;
    }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };
