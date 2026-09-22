export const MEDIA_SCHEME = 'threads-media';
export const IPC = {
  current: 'tmm:collection:current',
  choose: 'tmm:collection:choose',
  refresh: 'tmm:collection:refresh',
  downloadStatus: 'tmm:download:status',
  downloadPrepare: 'tmm:download:prepare',
  downloadStart: 'tmm:download:start',
  downloadStop: 'tmm:download:stop',
  downloadRecover: 'tmm:download:recover',
  exportPost: 'tmm:post:export',
  saveMediaEdit: 'tmm:media:edit',
  deleteMedia: 'tmm:media:delete',
  recoverDeletions: 'tmm:media:delete-recover',
  savePostComment: 'tmm:post:comment',
  openPostLink: 'tmm:post:open-link',
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
}
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
  stopDownload(): Promise<DownloadView>;
  recoverDownloads(): Promise<DownloadView>;
  exportPost(postKey: string): Promise<PostExportResult>;
  saveMediaEdit(input: MediaEditInput): Promise<MediaEditResult>;
  deleteMedia(input: MediaDeleteInput): Promise<MediaDeleteResult>;
  recoverDeletions(): Promise<MediaDeleteResult>;
  savePostComment(input: SavePostCommentInput): Promise<PostCommentResult>;
  openPostLink(input: OpenPostLinkInput): Promise<PostLinkResult>;
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
  received: number;
  total: number | null;
  revision: number;
  batch?: DownloadBatch | null;
}
