import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CollectionView, Post, Problem } from '../shared/contracts';
import {
  THREADS_INSIGHTS_HOUR,
  type ThreadsPublication,
  type ThreadsPublishProgress,
  type ThreadsResult,
  type ThreadsState,
} from '../shared/threads-api';
import { validPostDraftActionInput } from '../shared/post-export';
import { ViewError } from './collection';
import { ThreadsAccountError, type ThreadsAccountManager } from './threads-account';
import { ThreadsApiError, type ThreadsClient, type ThreadsContainerFields } from './threads-client';
import { SecretStoreError } from './threads-secret-store';
import { FileServerError, type FileServerStorage } from './file-server-storage';
import type { ThreadsUploadFile } from './threads-media';

const DAY = 86_400_000;
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const remoteId = (value: unknown): value is string =>
  typeof value === 'string' && /^\d{1,40}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const iso = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || iso(value);
const validMetrics = (value: unknown) =>
  value === null ||
  (object(value) &&
    ['views', 'likes', 'replies'].every(
      (key) => value[key] === null || (Number.isSafeInteger(value[key]) && Number(value[key]) >= 0),
    ));
const validProblem = (value: unknown) =>
  value === null ||
  (object(value) &&
    typeof value.code === 'string' &&
    /^[a-z_]{1,80}$/.test(value.code) &&
    typeof value.message === 'string' &&
    value.message.length < 2000);
export interface PublicationRecord extends ThreadsPublication {
  libraryId: string;
  parentRemoteId: string | null;
  containerId: string | null;
  childIds: string[];
  media: { mediaId: string; sha256: string; kind: 'image' | 'video' }[];
}
export interface ThreadsHistory {
  version: 1;
  records: PublicationRecord[];
  sync: Record<
    string,
    { attemptedAt: string | null; succeededAt: string | null; retryAt: string | null }
  >;
}
export function validThreadsHistory(value: unknown): value is ThreadsHistory {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.records) || !object(value.sync))
    return false;
  const ids = new Set<string>();
  const publishedIds = new Set<string>();
  for (const item of value.records) {
    if (
      !object(item) ||
      !uuid(item.id) ||
      ids.has(item.id) ||
      typeof item.libraryId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(item.libraryId) ||
      typeof item.postKey !== 'string' ||
      !item.postKey.length ||
      item.postKey.length > 512 ||
      !remoteId(item.accountId) ||
      typeof item.username !== 'string' ||
      !/^[A-Za-z0-9._]{1,100}$/.test(item.username) ||
      !['post', 'reply'].includes(String(item.kind)) ||
      typeof item.text !== 'string' ||
      item.text.length > 4000 ||
      !Number.isSafeInteger(item.draftRevision) ||
      Number(item.draftRevision) < 1 ||
      !nullableDate(item.commentUpdatedAt) ||
      !['preparing', 'processing', 'publishing', 'published', 'failed', 'uncertain'].includes(
        String(item.status),
      ) ||
      !(item.remoteId === null || remoteId(item.remoteId)) ||
      !(item.parentRemoteId === null || remoteId(item.parentRemoteId)) ||
      !(item.containerId === null || remoteId(item.containerId)) ||
      !iso(item.createdAt) ||
      !nullableDate(item.publishedAt) ||
      !nullableDate(item.metricsUpdatedAt) ||
      !validProblem(item.problem) ||
      !validProblem(item.metricsProblem) ||
      !Array.isArray(item.childIds) ||
      item.childIds.length > 20 ||
      !item.childIds.every(remoteId) ||
      !Array.isArray(item.media) ||
      item.media.length > 20 ||
      !item.media.every(
        (m) =>
          object(m) &&
          typeof m.mediaId === 'string' &&
          /^[a-f0-9]{32}$/.test(m.mediaId) &&
          typeof m.sha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(m.sha256) &&
          ['image', 'video'].includes(String(m.kind)),
      ) ||
      !validMetrics(item.metrics)
    )
      return false;
    if (item.status === 'published' && (!item.remoteId || !item.publishedAt)) return false;
    if (item.kind === 'reply' && !item.parentRemoteId) return false;
    if (item.remoteId) {
      if (publishedIds.has(item.remoteId)) return false;
      publishedIds.add(item.remoteId);
    }
    ids.add(item.id);
  }
  return Object.entries(value.sync).every(
    ([id, sync]) =>
      remoteId(id) &&
      object(sync) &&
      nullableDate(sync.attemptedAt) &&
      nullableDate(sync.succeededAt) &&
      nullableDate(sync.retryAt),
  );
}

export interface ThreadsPublishingOptions {
  userData: string;
  accounts: Pick<
    ThreadsAccountManager,
    'status' | 'credentials' | 'connect' | 'disconnect' | 'refreshIfDue'
  >;
  storage: Pick<
    FileServerStorage,
    'status' | 'upload' | 'delete' | 'pendingKeys' | 'connect' | 'disconnect'
  >;
  client: Pick<
    ThreadsClient,
    'createContainer' | 'publishContainer' | 'containerStatus' | 'insights' | 'retrieveMedia'
  >;
  history: { read(): Promise<ThreadsHistory | null>; write(value: ThreadsHistory): Promise<void> };
  currentView(): CollectionView;
  refresh(): Promise<CollectionView>;
  localBusy(): boolean;
  prepareMedia(root: string, mediaIds: string[], directory: string): Promise<ThreadsUploadFile[]>;
  confirm(summary: {
    username: string;
    kind: 'post' | 'reply';
    text: string;
    mediaCount: number;
  }): Promise<boolean>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}
function safeProblem(error: unknown): Problem {
  if (
    error instanceof ThreadsApiError ||
    error instanceof ThreadsAccountError ||
    error instanceof FileServerError ||
    error instanceof ViewError
  )
    return { code: error.code, message: error.message };
  if (error instanceof SecretStoreError)
    return {
      code: 'threads_history',
      message:
        '암호화된 API 이력을 저장하거나 읽지 못했습니다. 기존 파일을 보존했으며 다시 게시하지 않습니다.',
    };
  return {
    code: 'threads_failed',
    message: 'Threads 작업을 완료하지 못했습니다. 연결 상태를 확인하세요.',
  };
}
const uncertain: Problem = {
  code: 'threads_uncertain',
  message:
    '게시 성공 여부를 확인해야 합니다. 중복을 막기 위해 다시 업로드하지 않습니다. Threads에서 글을 확인한 뒤 상태를 연결하세요.',
};
function publicRecord(item: PublicationRecord): ThreadsPublication {
  const {
    id,
    postKey,
    accountId,
    username,
    kind,
    text,
    draftRevision,
    commentUpdatedAt,
    status,
    remoteId,
    createdAt,
    publishedAt,
    metrics,
    metricsUpdatedAt,
    problem,
    metricsProblem,
  } = item;
  return {
    id,
    postKey,
    accountId,
    username,
    kind,
    text,
    draftRevision,
    commentUpdatedAt,
    status,
    remoteId,
    createdAt,
    publishedAt,
    metrics,
    metricsUpdatedAt,
    problem,
    metricsProblem,
  };
}
export class ThreadsPublishingController {
  private data: ThreadsHistory = { version: 1, records: [], sync: {} };
  private loading?: Promise<void>;
  private fatal: Problem | null = null;
  private pending: Promise<ThreadsResult> | null = null;
  private task: 'publish' | 'sync' | 'settings' | null = null;
  private publishProgress: ThreadsPublishProgress | null = null;
  private cleanedLocalCopies = false;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  constructor(private readonly options: ThreadsPublishingOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  get active() {
    return this.pending !== null;
  }
  get publishing() {
    return this.task === 'publish';
  }
  private date() {
    return new Date(this.now()).toISOString();
  }
  private async load() {
    if (!this.loading)
      this.loading = (async () => {
        try {
          const saved = await this.options.history.read();
          if (!saved && (await this.options.accounts.status()).account)
            throw new ViewError(
              'threads_history_missing',
              '연결 계정의 API 이력이 없습니다. 중복 게시를 막기 위해 기존 이력 복구가 필요합니다.',
            );
          if (saved) {
            if (!validThreadsHistory(saved)) throw new SecretStoreError('corrupt');
            this.data = saved;
            const interrupted = saved.records.some((item) =>
              ['preparing', 'processing', 'publishing'].includes(item.status),
            );
            if (interrupted)
              await this.commit({
                ...saved,
                records: saved.records.map((item) =>
                  item.status === 'publishing'
                    ? { ...item, status: 'uncertain', problem: uncertain }
                    : ['preparing', 'processing'].includes(item.status)
                      ? {
                          ...item,
                          status: 'failed',
                          problem: {
                            code: 'threads_interrupted',
                            message: '게시 전 준비가 중단되었습니다. 다시 업로드할 수 있습니다.',
                          },
                        }
                      : item,
                ),
              });
          }
        } catch (error) {
          this.fatal = safeProblem(error);
        }
      })();
    await this.loading;
    if (this.fatal) throw new ViewError(this.fatal.code, this.fatal.message);
  }
  private async commit(next: ThreadsHistory) {
    try {
      await this.options.history.write(next);
      this.data = next;
    } catch (error) {
      this.fatal = safeProblem(error);
      throw error;
    }
  }
  async exportLibraryHistory(libraryId: string): Promise<ThreadsHistory> {
    await this.load();
    if (this.active)
      throw new ViewError('threads_busy', '진행 중인 게시 작업이 끝난 뒤 이전하세요.');
    const records = this.data.records
      .filter((item) => item.libraryId === libraryId)
      .map((item) => ({
        ...publicRecord(item),
        libraryId: item.libraryId,
        parentRemoteId: item.parentRemoteId,
        containerId: item.containerId,
        childIds: [...item.childIds],
        media: item.media.map(({ mediaId, sha256, kind }) => ({ mediaId, sha256, kind })),
      }));
    const accounts = new Set(records.map((item) => item.accountId));
    return structuredClone({
      version: 1,
      records,
      sync: Object.fromEntries(Object.entries(this.data.sync).filter(([id]) => accounts.has(id))),
    });
  }
  async importLibraryHistory(libraryId: string, imported: ThreadsHistory): Promise<void> {
    await this.load();
    if (this.active)
      throw new ViewError('threads_busy', '진행 중인 게시 작업이 끝난 뒤 이전하세요.');
    const invalid = () =>
      new ViewError(
        'threads_transfer_history',
        '옮긴 게시 이력이 현재 라이브러리와 맞지 않습니다. 기존 이력은 보존했습니다.',
      );
    if (
      !validThreadsHistory(imported) ||
      imported.records.some((item) => item.libraryId !== libraryId)
    )
      throw invalid();
    const records = structuredClone(this.data.records);
    for (const raw of imported.records) {
      const item: PublicationRecord = { ...structuredClone(raw) };
      // An exported in-flight publication is never permission to publish again.
      if (['preparing', 'processing', 'publishing'].includes(item.status)) {
        item.status = 'uncertain';
        item.problem = uncertain;
      }
      const index = records.findIndex(
        (current) =>
          current.id === item.id || (item.remoteId !== null && current.remoteId === item.remoteId),
      );
      if (index < 0) {
        records.push(item);
        continue;
      }
      const current = records[index];
      if (
        ['libraryId', 'accountId', 'postKey', 'kind'].some(
          (key) => current[key as keyof PublicationRecord] !== item[key as keyof PublicationRecord],
        ) ||
        (current.remoteId && item.remoteId && current.remoteId !== item.remoteId)
      )
        throw invalid();
      // Older copies cannot undo a confirmed publication or an unresolved result.
      if (current.status === 'published') continue;
      if (
        item.status === 'published' ||
        (current.status !== 'uncertain' && item.status === 'uncertain')
      )
        records[index] = item;
    }
    const sync = structuredClone(this.data.sync);
    const accounts = new Set(imported.records.map((item) => item.accountId));
    for (const [id, value] of Object.entries(imported.sync)) {
      if (!accounts.has(id)) continue;
      const latest = (a: string | null, b: string | null) =>
        !a ? b : !b || Date.parse(a) >= Date.parse(b) ? a : b;
      const current = sync[id];
      sync[id] = current
        ? {
            attemptedAt: latest(current.attemptedAt, value.attemptedAt),
            succeededAt: latest(current.succeededAt, value.succeededAt),
            retryAt: latest(current.retryAt, value.retryAt),
          }
        : { ...value };
    }
    const next: ThreadsHistory = { version: 1, records, sync };
    if (!validThreadsHistory(next)) throw invalid();
    if (JSON.stringify(next) !== JSON.stringify(this.data)) await this.commit(next);
  }
  private record(id: string) {
    const item = this.data.records.find((r) => r.id === id);
    if (!item) throw new ViewError('threads_record', 'API 게시 이력을 찾을 수 없습니다.');
    return item;
  }
  private async update(id: string, fields: Partial<PublicationRecord>) {
    await this.commit({
      ...this.data,
      records: this.data.records.map((item) => (item.id === id ? { ...item, ...fields } : item)),
    });
  }
  private latest(accountId: string, publishedBy = Infinity) {
    return this.data.records
      .filter(
        (item) =>
          item.accountId === accountId &&
          item.kind === 'post' &&
          item.status === 'published' &&
          item.remoteId &&
          item.publishedAt &&
          Date.parse(item.publishedAt) <= publishedBy,
      )
      .sort(
        (a, b) =>
          (b.publishedAt ?? '').localeCompare(a.publishedAt ?? '') ||
          b.createdAt.localeCompare(a.createdAt),
      )
      .slice(0, 5);
  }
  async state(): Promise<ThreadsState> {
    await this.load().catch(() => {});
    const account = await this.options.accounts.status();
    let storage = null;
    let problem = this.fatal;
    try {
      storage = await this.options.storage.status();
    } catch (error) {
      problem ??= safeProblem(error);
    }
    const libraryId = this.options.currentView().snapshot?.libraryId;
    return {
      account: account.account,
      accountProblem: account.problem,
      storageConfigured: storage !== null,
      fileServer: storage,
      publications: this.data.records
        .filter((item) => item.libraryId === libraryId)
        .map(publicRecord),
      recentPublications: account.account ? this.latest(account.account.id).map(publicRecord) : [],
      busy: this.active,
      publishProgress: this.publishProgress ? { ...this.publishProgress } : null,
      syncing: this.task === 'sync',
      lastSyncAt: account.account
        ? (this.data.sync[account.account.id]?.succeededAt ?? null)
        : null,
      problem,
    };
  }
  private run(
    task: 'publish' | 'sync' | 'settings',
    action: () => Promise<boolean | void>,
  ): Promise<ThreadsResult> {
    if (this.pending) {
      if (task === 'sync' && this.task === 'sync') return this.pending;
      return Promise.resolve({
        status: 'error',
        problem: { code: 'threads_busy', message: '진행 중인 Threads 작업이 끝난 뒤 실행하세요.' },
      });
    }
    this.task = task;
    const work = (async (): Promise<ThreadsResult> => {
      try {
        await this.load();
        if ((await action()) === false) return { status: 'cancelled' };
        const state = await this.state();
        return {
          status: 'ok',
          state: { ...state, busy: false, syncing: false, publishProgress: null },
        };
      } catch (error) {
        return { status: 'error', problem: safeProblem(error) };
      }
    })();
    this.pending = work.finally(() => {
      this.pending = null;
      this.task = null;
      this.publishProgress = null;
    });
    return this.pending;
  }
  connect(input: unknown) {
    return this.run('settings', async () => {
      await this.commit(this.data);
      const result = await this.options.accounts.connect(input);
      if (result.problem) throw new ViewError(result.problem.code, result.problem.message);
    });
  }
  disconnect() {
    return this.run('settings', async () => {
      const result = await this.options.accounts.disconnect();
      if (result.problem) throw new ViewError(result.problem.code, result.problem.message);
    });
  }
  connectFileServer(input: unknown) {
    return this.run('settings', async () => {
      await this.options.storage.connect(input);
    });
  }
  disconnectFileServer() {
    return this.run('settings', async () => {
      await this.options.storage.disconnect();
    });
  }
  publish(input: unknown, kind: 'post' | 'reply') {
    return this.run('publish', async () => {
      if (this.options.localBusy())
        throw new ViewError('threads_busy', '진행 중인 로컬 작업이 끝난 뒤 업로드하세요.');
      const replyInput =
        kind === 'reply' &&
        object(input) &&
        Object.keys(input).sort().join(',') ===
          'expectedCommentUpdatedAt,expectedRevision,postKey' &&
        iso(input.expectedCommentUpdatedAt);
      const base =
        kind === 'reply' && replyInput
          ? { postKey: input.postKey, expectedRevision: input.expectedRevision }
          : input;
      if (!validPostDraftActionInput(base) || (kind === 'reply' && !replyInput))
        throw new ViewError('threads_input', '게시글과 저장 버전을 확인하세요.');
      const progress = (
        stage: ThreadsPublishProgress['stage'],
        file?: ThreadsUploadFile,
        index?: number,
        total?: number,
      ) => {
        this.publishProgress = {
          postKey: base.postKey,
          kind,
          stage,
          ...(file ? { mediaKind: file.kind, current: index, total } : {}),
        };
      };
      progress('checking');
      const request = input as { expectedCommentUpdatedAt?: unknown };
      const view = await this.options.refresh();
      if (view.error) throw new ViewError(view.error.code, view.error.message);
      const snapshot = view.snapshot;
      if (
        !snapshot?.libraryId ||
        snapshot.stateStatus !== 'read_only' ||
        snapshot.warnings.some((w) =>
          [
            'deletion_recovery_required',
            'drafts_unavailable',
            ...(kind === 'reply' ? ['comments_unavailable'] : []),
          ].includes(w.code),
        )
      )
        throw new ViewError('threads_source', '라이브러리와 저장된 게시글 정보를 확인하세요.');
      const post = snapshot.posts.find((item) => item.key === base.postKey);
      if (!post?.draft || post.draft.revision !== base.expectedRevision)
        throw new ViewError(
          'threads_revision',
          '등록 글이 변경되었습니다. 최신 글을 다시 열어 업로드하세요.',
        );
      const { accessToken, account } = await this.options.accounts.credentials();
      const same = this.data.records.filter(
        (item) =>
          item.libraryId === snapshot.libraryId &&
          item.postKey === base.postKey &&
          item.accountId === account.id,
      );
      if (same.some((item) => item.kind === kind && item.status !== 'failed'))
        throw new ViewError(
          'threads_duplicate',
          '이미 게시했거나 결과 확인이 필요한 글입니다. 상태를 먼저 확인하세요.',
        );
      const parent = same.find(
        (item) => item.kind === 'post' && item.status === 'published' && item.remoteId,
      );
      if (
        kind === 'reply' &&
        (!parent?.remoteId ||
          !post.comment ||
          post.comment.updatedAt !== request.expectedCommentUpdatedAt)
      )
        throw new ViewError(
          'threads_reply',
          '원글을 먼저 API로 게시하고 최신 댓글 정보를 저장하세요.',
        );
      const text =
        kind === 'post'
          ? post.draft.caption
          : [post.comment!.caption, post.comment!.link].filter(Boolean).join('\n');
      if ([...text].length > 500 || (kind === 'reply' && !text.trim()))
        throw new ViewError(
          'threads_text_limit',
          'Threads에 올릴 본문은 500자 이내로 작성하세요. 댓글 링크도 글자 수에 포함됩니다.',
        );
      if (kind === 'post') this.validateSelection(post);
      if (kind === 'post' && !(await this.options.storage.status()))
        throw new ViewError(
          'threads_storage_missing',
          '설정에서 파일 서버 연결 코드를 등록하세요.',
        );
      progress('confirming');
      if (
        !(await this.options.confirm({
          username: account.username,
          kind,
          text,
          mediaCount: kind === 'post' ? post.draft.mediaIds.length : 0,
        }))
      )
        return false;
      progress('preparing');
      const id = randomUUID();
      const item: PublicationRecord = {
        id,
        libraryId: snapshot.libraryId,
        postKey: base.postKey,
        accountId: account.id,
        username: account.username,
        kind,
        text,
        draftRevision: post.draft.revision,
        commentUpdatedAt: kind === 'reply' ? post.comment!.updatedAt : null,
        status: 'preparing',
        remoteId: null,
        parentRemoteId: kind === 'reply' ? parent!.remoteId : null,
        containerId: null,
        childIds: [],
        media: [],
        createdAt: this.date(),
        publishedAt: null,
        metrics: null,
        metricsUpdatedAt: null,
        problem: null,
        metricsProblem: null,
      };
      await this.commit({ ...this.data, records: [...this.data.records, item] });
      const directory = join(this.options.userData, 'threads-outbox', id);
      try {
        const files =
          kind === 'post'
            ? await this.options.prepareMedia(snapshot.root, post.draft.mediaIds, directory)
            : [];
        await this.update(id, {
          media: files.map(({ mediaId, sha256, kind }) => ({ mediaId, sha256, kind })),
        });
        const children: string[] = [];
        let fields: ThreadsContainerFields = {
          media_type: 'TEXT',
          text,
          ...(item.parentRemoteId ? { reply_to_id: item.parentRemoteId } : {}),
        };
        for (const [index, file] of files.entries()) {
          progress('uploading', file, index + 1, files.length);
          const uploaded = await this.options.storage.upload(id, index + 1, file);
          const media: ThreadsContainerFields = {
            media_type: file.kind === 'image' ? 'IMAGE' : 'VIDEO',
            ...(file.kind === 'image' ? { image_url: uploaded.url } : { video_url: uploaded.url }),
          };
          if (files.length > 1) {
            progress('processing', file, index + 1, files.length);
            const child = await this.options.client.createContainer(accessToken, account.id, {
              ...media,
              is_carousel_item: true,
            });
            children.push(child.id);
            await this.update(id, { childIds: [...children] });
            await this.waitReady(accessToken, child.id);
          } else fields = { ...media, text };
        }
        if (children.length) fields = { media_type: 'CAROUSEL', text, children };
        progress('processing');
        const container = await this.options.client.createContainer(
          accessToken,
          account.id,
          fields,
        );
        await this.update(id, { containerId: container.id, status: 'processing' });
        await this.waitReady(accessToken, container.id);
        // This durable intent must precede the irreversible request.
        await this.update(id, { status: 'publishing' });
        progress('publishing');
        const published = await this.options.client.publishContainer(
          accessToken,
          account.id,
          container.id,
        );
        progress('saving');
        await this.update(id, {
          status: 'published',
          remoteId: published.id,
          publishedAt: this.date(),
          problem: null,
        });
        progress('cleaning');
        await this.cleanup(id);
      } catch (error) {
        const current = this.record(id);
        const ambiguous =
          current.status === 'publishing' &&
          !(error instanceof ThreadsApiError && !error.maybeSent);
        if (!this.fatal)
          await this.update(id, {
            status: ambiguous ? 'uncertain' : 'failed',
            problem: ambiguous ? uncertain : safeProblem(error),
          });
        if (!ambiguous && !this.fatal) {
          progress('cleaning');
          await this.cleanup(id);
        }
        throw ambiguous ? new ViewError(uncertain.code, uncertain.message) : error;
      } finally {
        progress('cleaning');
        // Only this operation's app-owned local copies are removed.
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    });
  }
  private validateSelection(post: Post) {
    const ids = post.draft!.mediaIds;
    const available = [...post.attachments, ...(post.edits ?? []), ...(post.aiImages ?? [])];
    if (
      !ids.length ||
      ids.length > 20 ||
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) => !available.some((a) => a.mediaId === id && a.status === 'saved' && a.localUrl),
      )
    )
      throw new ViewError('threads_media_limit', '사용 가능한 첨부를 1~20개 선택하고 저장하세요.');
  }
  private async waitReady(token: string, id: string) {
    for (let attempt = 0; attempt <= 5; attempt++) {
      if (attempt) await this.sleep(60_000);
      const result = await this.options.client.containerStatus(token, id);
      if (result.status === 'FINISHED') return;
      if (result.status !== 'IN_PROGRESS')
        throw new ViewError(
          'threads_container',
          'Threads가 첨부를 처리하지 못했습니다. 파일 형식과 게시 조건을 확인하세요.',
        );
    }
    throw new ViewError(
      'threads_processing_timeout',
      '미디어 처리 시간이 초과되었습니다. 게시하지 않았으며 다시 시도할 수 있습니다.',
    );
  }
  private async cleanup(id: string) {
    try {
      const keys = (await this.options.storage.pendingKeys()).filter((key) =>
        key.startsWith(`threads-media-manager/${id}/`),
      );
      await this.options.storage.delete(keys);
      if (this.record(id).problem?.code === 'threads_cleanup')
        await this.update(id, { problem: null });
    } catch {
      const item = this.record(id);
      await this.update(id, {
        problem: item.problem ?? {
          code: 'threads_cleanup',
          message: '임시 업로드 파일 정리가 남았습니다. 앱을 다음 실행할 때 다시 시도합니다.',
        },
      });
    }
  }
  sync() {
    return this.run('sync', () => this.syncNow(true));
  }
  async tick(startup = false): Promise<void> {
    if (this.active || this.options.localBusy()) return;
    await this.run('sync', async () => {
      await this.options.accounts.refreshIfDue();
      const account = (await this.options.accounts.status()).account;
      if (!this.cleanedLocalCopies) {
        for (const item of this.data.records)
          await rm(join(this.options.userData, 'threads-outbox', item.id), {
            recursive: true,
            force: true,
          }).catch(() => {});
        this.cleanedLocalCopies = true;
      }
      // Media storage availability must not prevent independent insight requests.
      const pendingKeys = await this.options.storage.pendingKeys().catch(() => [] as string[]);
      for (const item of this.data.records.filter(
        (r) =>
          ['published', 'failed'].includes(r.status) &&
          pendingKeys.some((key) => key.startsWith(`threads-media-manager/${r.id}/`)),
      )) {
        await this.cleanup(item.id);
        await rm(join(this.options.userData, 'threads-outbox', item.id), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
      if (!account) return;
      await this.syncNow(false, startup);
    });
  }
  private async syncNow(manual: boolean, startup = false) {
    const status = await this.options.accounts.status();
    if (!status.account && !manual) return;
    const slot = new Date(this.now());
    slot.setHours(THREADS_INSIGHTS_HOUR, 0, 0, 0);
    const scheduledAt = slot.getTime();
    const today = new Date(this.now()).toDateString();
    // Startup may check existing posts immediately. Regular ticks wait for
    // today's slot and exclude posts registered after it, so publication never
    // triggers a first statistics request as a follow-up operation.
    if (!manual && !startup && this.now() < scheduledAt) return;
    const previous = (status.account && this.data.sync[status.account.id]) || {
      attemptedAt: null,
      succeededAt: null,
      retryAt: null,
    };
    if (!manual && previous.attemptedAt && new Date(previous.attemptedAt).toDateString() === today)
      return;
    if (previous.retryAt && Date.parse(previous.retryAt) > this.now()) {
      if (manual)
        throw new ViewError(
          'threads_rate_limit',
          'Threads의 요청 대기 시간이 남아 있습니다. 잠시 후 다시 조회하세요.',
        );
      return;
    }
    const posts = status.account
      ? this.latest(status.account.id, manual || startup ? Infinity : scheduledAt)
      : [];
    if (!posts.length && !manual) return;
    const { accessToken, account } = await this.options.accounts.credentials();
    if (!posts.length) return;
    await this.commit({
      ...this.data,
      sync: { ...this.data.sync, [account.id]: { ...previous, attemptedAt: this.date() } },
    });
    let allSucceeded = true;
    for (const item of posts) {
      try {
        const metrics = await this.options.client.insights(accessToken, item.remoteId!);
        if (Object.values(metrics).some((v) => v === null))
          throw new ViewError(
            'threads_metrics_pending',
            '아직 일부 통계가 제공되지 않았습니다. 이전 수치를 유지합니다.',
          );
        await this.update(item.id, {
          metrics,
          metricsUpdatedAt: this.date(),
          metricsProblem: null,
        });
      } catch (error) {
        if (this.fatal) throw error;
        allSucceeded = false;
        await this.update(item.id, { metricsProblem: safeProblem(error) });
        if (
          error instanceof ThreadsApiError &&
          ['rate_limited', 'auth_expired', 'permission_missing'].includes(error.code)
        ) {
          const retryAt =
            error.code === 'rate_limited'
              ? new Date(
                  this.now() + Math.max(error.retryAfterSeconds ?? 60, 60) * 1000,
                ).toISOString()
              : null;
          await this.commit({
            ...this.data,
            sync: { ...this.data.sync, [account.id]: { ...this.data.sync[account.id], retryAt } },
          });
          throw error;
        }
      }
    }
    if (allSucceeded)
      await this.commit({
        ...this.data,
        sync: {
          ...this.data.sync,
          [account.id]: { ...this.data.sync[account.id], succeededAt: this.date(), retryAt: null },
        },
      });
    else if (manual)
      throw new ViewError(
        'threads_sync_partial',
        '일부 게시글의 통계를 갱신하지 못했습니다. 마지막 정상 수치와 오류를 확인하세요.',
      );
  }
  reconcile(input: unknown) {
    return this.run('publish', async () => {
      if (
        !object(input) ||
        !uuid(input.id) ||
        !(input.remoteId === undefined || remoteId(input.remoteId))
      )
        throw new ViewError('threads_input', '확인할 게시 이력과 Threads 게시물 ID를 확인하세요.');
      const item = this.record(input.id);
      const { accessToken, account } = await this.options.accounts.credentials();
      if (item.accountId !== account.id || item.status !== 'uncertain' || !item.containerId)
        throw new ViewError(
          'threads_reconcile',
          '이 계정에서 결과 확인이 필요한 게시글만 연결할 수 있습니다.',
        );
      const status = await this.options.client.containerStatus(accessToken, item.containerId);
      if (['ERROR', 'EXPIRED'].includes(status.status)) {
        await this.update(item.id, {
          status: 'failed',
          problem: {
            code: 'threads_not_published',
            message: 'Threads에서 게시 실패 또는 만료를 확인했습니다. 다시 업로드할 수 있습니다.',
          },
        });
        await this.cleanup(item.id);
        return;
      }
      if (!input.remoteId) {
        await this.update(item.id, {
          problem: {
            code: 'threads_uncertain',
            message:
              status.status === 'PUBLISHED'
                ? 'Threads 게시가 확인되었습니다. 실제 게시글 ID를 입력해 이력과 연결하세요.'
                : uncertain.message,
          },
        });
        return;
      }
      const media = await this.options.client.retrieveMedia(accessToken, input.remoteId);
      const publishedTime = Date.parse(media.timestamp ?? '');
      if (
        status.status !== 'PUBLISHED' ||
        (media.ownerId !== null
          ? media.ownerId !== account.id
          : media.username?.toLowerCase() !== account.username.toLowerCase()) ||
        (media.text ?? '').trim() !== item.text.trim() ||
        !media.timestamp ||
        !Number.isFinite(publishedTime) ||
        publishedTime < Date.parse(item.createdAt) - 300_000 ||
        publishedTime > Date.parse(item.createdAt) + DAY ||
        (item.kind === 'reply'
          ? media.repliedToId !== item.parentRemoteId
          : media.isReply !== false) ||
        this.data.records.some((r) => r.id !== item.id && r.remoteId === media.id)
      )
        throw new ViewError(
          'threads_reconcile_mismatch',
          '입력한 ID의 계정·본문·게시 시각·답글 연결이 이 작업과 일치하지 않습니다.',
        );
      await this.update(item.id, {
        status: 'published',
        remoteId: media.id,
        publishedAt: media.timestamp,
        problem: null,
      });
      await this.cleanup(item.id);
    });
  }
}
