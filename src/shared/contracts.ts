export const MEDIA_SCHEME = 'threads-media';
export const IPC = {
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
  reasons: string[];
  source: string;
  attachments: Attachment[];
  edits?: Attachment[];
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
export interface ThreadsMediaApi {
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
