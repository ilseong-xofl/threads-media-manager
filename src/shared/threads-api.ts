import type { PostDraftActionInput, PostLinkResult, Problem } from './contracts';

export interface ThreadsAccountView {
  id: string;
  username: string;
  connectedAt: string;
  expiresAt: string;
  lastRefreshedAt: string | null;
  lastRefreshAttemptAt: string | null;
  requiresReconnect?: boolean;
}
export interface ConnectThreadsInput {
  accessToken: string;
}
export interface FileServerConnectionView {
  server: string;
  savedAt: string;
}
export interface ConnectFileServerInput {
  connectionCode: string;
}
export interface ThreadsMetrics {
  views: number | null;
  likes: number | null;
  replies: number | null;
}
export interface ThreadsPublication {
  id: string;
  postKey: string;
  accountId: string;
  username: string;
  kind: 'post' | 'reply';
  text: string;
  draftRevision: number;
  commentUpdatedAt: string | null;
  status: 'preparing' | 'processing' | 'publishing' | 'published' | 'failed' | 'uncertain';
  remoteId: string | null;
  createdAt: string;
  publishedAt: string | null;
  metrics: ThreadsMetrics | null;
  metricsUpdatedAt: string | null;
  problem: Problem | null;
  metricsProblem: Problem | null;
}
export const THREADS_INSIGHTS_HOUR = 10;
export interface ThreadsPublishProgress {
  postKey: string;
  kind: 'post' | 'reply';
  stage:
    | 'checking'
    | 'confirming'
    | 'preparing'
    | 'uploading'
    | 'processing'
    | 'publishing'
    | 'saving'
    | 'cleaning';
  mediaKind?: 'image' | 'video';
  current?: number;
  total?: number;
}
export interface ThreadsState {
  account: ThreadsAccountView | null;
  accountProblem: Problem | null;
  storageConfigured: boolean;
  fileServer: FileServerConnectionView | null;
  publications: ThreadsPublication[];
  recentPublications: ThreadsPublication[];
  busy: boolean;
  publishProgress?: ThreadsPublishProgress | null;
  syncing: boolean;
  lastSyncAt: string | null;
  problem: Problem | null;
}
export type ThreadsResult =
  | { status: 'ok'; state: ThreadsState }
  | { status: 'cancelled' }
  | { status: 'error'; problem: Problem };
export interface PublishThreadsCommentInput extends PostDraftActionInput {
  expectedCommentUpdatedAt: string;
}
export interface ThreadsApiMethods {
  threadsState(): Promise<ThreadsState>;
  openThreadsPublication(input: { id: string }): Promise<PostLinkResult>;
  connectThreads(input: ConnectThreadsInput): Promise<ThreadsResult>;
  disconnectThreads(): Promise<ThreadsResult>;
  connectFileServer(input: ConnectFileServerInput): Promise<ThreadsResult>;
  disconnectFileServer(): Promise<ThreadsResult>;
  publishThreadsPost(input: PostDraftActionInput): Promise<ThreadsResult>;
  publishThreadsComment(input: PublishThreadsCommentInput): Promise<ThreadsResult>;
  syncThreadsInsights(): Promise<ThreadsResult>;
  reconcileThreadsPublication(input: { id: string; remoteId?: string }): Promise<ThreadsResult>;
}
