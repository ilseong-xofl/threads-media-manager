import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionView, Post } from '../shared/contracts';
import type { ThreadsPublishProgress } from '../shared/threads-api';
import { ThreadsApiError, type ThreadsContainerStatus } from './threads-client';
import { SecretStoreError } from './threads-secret-store';
import { FileServerError } from './file-server-storage';
import {
  ThreadsPublishingController,
  validThreadsHistory,
  type PublicationRecord,
  type ThreadsHistory,
  type ThreadsPublishingOptions,
} from './threads-publishing';

const dirs: string[] = [];
const TOKEN = 'SYNTHETIC_THREADS_TOKEN_123456';
const LIBRARY = 'a'.repeat(32);
const MEDIA = 'b'.repeat(32);
const AT = '2026-09-28T12:00:00.000Z';
const request = { postKey: 'source:one', expectedRevision: 1 };
function savedRecord(index: number, extra: Partial<PublicationRecord> = {}): PublicationRecord {
  return {
    id: randomUUID(),
    libraryId: LIBRARY,
    postKey: `source:${index}`,
    accountId: '123',
    username: 'owner',
    kind: 'post',
    text: `saved post ${index}`,
    draftRevision: 1,
    commentUpdatedAt: null,
    status: 'published',
    remoteId: String(1000 + index),
    parentRemoteId: null,
    containerId: String(2000 + index),
    childIds: [],
    media: [{ mediaId: MEDIA, sha256: 'c'.repeat(64), kind: 'image' }],
    createdAt: new Date(Date.parse(AT) - (10 - index) * 60_000).toISOString(),
    publishedAt: new Date(Date.parse(AT) - (10 - index) * 60_000).toISOString(),
    metrics: { views: 40, likes: 2, replies: 1 },
    metricsUpdatedAt: '2026-09-27T12:00:00.000Z',
    problem: null,
    metricsProblem: null,
    ...extra,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(records: PublicationRecord[] = []) {
  const userData = await mkdtemp(join(tmpdir(), 'threads-publishing-test-'));
  dirs.push(userData);
  let saved: ThreadsHistory | null = { version: 1, records: structuredClone(records), sync: {} };
  let now = Date.parse(AT);
  const account = {
    id: '123',
    username: 'owner',
    connectedAt: AT,
    expiresAt: '2026-11-27T12:00:00.000Z',
    lastRefreshedAt: null,
    lastRefreshAttemptAt: null,
    requiresReconnect: false,
  };
  const accountView = () => ({ account: { ...account }, history: [], problem: null, busy: false });
  const accounts = {
    status: vi.fn(async () => accountView()),
    credentials: vi.fn(async () => ({ accessToken: TOKEN, account: { ...account } })),
    connect: vi.fn(async () => accountView()),
    disconnect: vi.fn(async () => ({ ...accountView(), account: null })),
    refreshIfDue: vi.fn(async () => accountView()),
  };
  const post = {
    key: request.postKey,
    account: 'source',
    postId: 'original-source-id',
    caption: 'source text',
    attachments: [
      {
        mediaId: MEDIA,
        ordinal: 1,
        kind: 'image',
        status: 'saved',
        localUrl: `threads-media://file/${MEDIA}`,
      },
    ],
    draft: {
      caption: 'Approved main text',
      mediaIds: [MEDIA],
      createdAt: AT,
      updatedAt: AT,
      revision: 1,
    },
    comment: { caption: 'Approved reply', link: 'https://example.test/product', updatedAt: AT },
  } as Post;
  const view = {
    error: null,
    snapshot: {
      root: '/synthetic-library',
      libraryId: LIBRARY,
      loadedAt: AT,
      sourceCount: 1,
      warnings: [],
      stateStatus: 'read_only',
      posts: [post],
    },
  } as CollectionView;
  let nextContainer = 3000;
  const client = {
    createContainer: vi.fn(async () => ({ id: String(++nextContainer) })),
    publishContainer: vi.fn(async () => ({ id: '9000' })),
    containerStatus: vi.fn(async (token: string, id: string) => ({
      id,
      status: 'FINISHED' as ThreadsContainerStatus,
    })),
    insights: vi.fn(async () => ({ views: 100, likes: 5, replies: 2 })),
    retrieveMedia: vi.fn(async (token: string, id: string) => ({
      id,
      text: 'Approved main text',
      permalink: null,
      username: 'owner',
      timestamp: AT,
      mediaType: 'IMAGE',
      ownerId: '123',
      isReply: false,
      repliedToId: null,
    })),
  };
  const storage = {
    status: vi.fn(async () => ({ server: 'https://tfs.ilscp.net', savedAt: AT })),
    connect: vi.fn(async () => ({ server: 'https://tfs.ilscp.net', savedAt: AT })),
    disconnect: vi.fn(async () => {}),
    upload: vi.fn(async (id: string, ordinal: number) => ({
      key: `threads-media-manager/${id}/${ordinal}.jpg`,
      url: 'https://tfs.ilscp.net/files/12345678-1234-4123-8123-123456789012/media.jpg',
    })),
    delete: vi.fn(async () => {}),
    pendingKeys: vi.fn(async () => [] as string[]),
  };
  const history = {
    read: vi.fn(async () => structuredClone(saved)),
    write: vi.fn(async (value: ThreadsHistory) => {
      if (!validThreadsHistory(value)) throw new SecretStoreError('corrupt');
      saved = structuredClone(value);
    }),
  };
  const options: ThreadsPublishingOptions = {
    userData,
    accounts,
    storage,
    client,
    history,
    currentView: () => view,
    refresh: vi.fn(async () => view),
    localBusy: vi.fn(() => false),
    prepareMedia: vi.fn(async () => [
      {
        path: '/synthetic-frozen.jpg',
        size: 8,
        contentType: 'image/jpeg',
        extension: 'jpg',
        kind: 'image' as const,
        mediaId: MEDIA,
        sha256: 'c'.repeat(64),
      },
    ]),
    confirm: vi.fn(async () => true),
    now: () => now,
    sleep: vi.fn(async () => {}),
  };
  const controller = new ThreadsPublishingController(options);
  return {
    controller,
    options,
    client,
    accounts,
    storage,
    history,
    view,
    post,
    getSaved: () => structuredClone(saved),
    setSaved: (value: ThreadsHistory | null) => {
      saved = value;
    },
    setNow: (value: number) => {
      now = value;
    },
    advance: (days: number) => {
      now += days * 86_400_000;
    },
    restart: () => new ThreadsPublishingController(options),
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Threads publish journal and recovery', () => {
  it('persists intent before publishing and records the actual remote ID without token or signed URLs', async () => {
    const f = await fixture();
    f.client.publishContainer.mockImplementationOnce(async () => {
      expect(f.getSaved()?.records[0].status).toBe('publishing');
      expect(f.getSaved()?.records[0].containerId).toBe('3001');
      return { id: '9000' };
    });
    const result = await f.controller.publish(request, 'post');
    expect(result.status).toBe('ok');
    expect(f.client.publishContainer).toHaveBeenCalledExactlyOnceWith(TOKEN, '123', '3001');
    expect(f.getSaved()?.records[0]).toMatchObject({ status: 'published', remoteId: '9000' });
    expect(JSON.stringify(f.getSaved())).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('signature=private');
  });
  it('keeps a successful publication when media cleanup fails and never republishes it', async () => {
    const f = await fixture();
    f.storage.pendingKeys.mockImplementation(async () =>
      f.getSaved()!.records.map((record) => `threads-media-manager/${record.id}/1.jpg`),
    );
    f.storage.delete.mockRejectedValueOnce(new Error('synthetic delete failure'));
    const result = await f.controller.publish(request, 'post');
    expect(result.status).toBe('ok');
    expect(f.getSaved()?.records[0]).toMatchObject({
      status: 'published',
      remoteId: '9000',
      problem: { code: 'threads_cleanup' },
    });
    expect(await f.controller.publish(request, 'post')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_duplicate' },
    });
    await f.controller.tick();
    expect(f.getSaved()?.records[0]).toMatchObject({
      status: 'published',
      remoteId: '9000',
      problem: null,
    });
    expect(f.client.publishContainer).toHaveBeenCalledTimes(1);
    expect(f.storage.delete).toHaveBeenCalledTimes(2);
  });
  it('performs no remote writes when initial durable storage fails', async () => {
    const f = await fixture();
    f.history.write.mockRejectedValueOnce(new SecretStoreError('storage'));
    expect((await f.controller.publish(request, 'post')).status).toBe('error');
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.client.createContainer).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
  });
  it('does not publish when persisting the final intent fails', async () => {
    const f = await fixture();
    const write = f.history.write.getMockImplementation()!;
    f.history.write.mockImplementation(async (value) => {
      if (value.records.some((record) => record.status === 'publishing'))
        throw new SecretStoreError('storage');
      await write(value);
    });
    expect((await f.controller.publish(request, 'post')).status).toBe('error');
    expect(f.client.createContainer).toHaveBeenCalledTimes(1);
    expect(f.client.publishContainer).not.toHaveBeenCalled();
    expect(f.getSaved()?.records[0].status).toBe('processing');
  });
  it('marks an ambiguous timeout uncertain and blocks another publish or automatic retry', async () => {
    const f = await fixture();
    f.client.publishContainer.mockRejectedValueOnce(
      new ThreadsApiError('timeout', { maybeSent: true }),
    );
    const result = await f.controller.publish(request, 'post');
    expect(result).toMatchObject({ status: 'error', problem: { code: 'threads_uncertain' } });
    expect(f.getSaved()?.records[0].status).toBe('uncertain');
    expect(await f.controller.publish(request, 'post')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_duplicate' },
    });
    await f.controller.tick();
    expect(f.client.publishContainer).toHaveBeenCalledTimes(1);
    expect(f.storage.delete).not.toHaveBeenCalled();
  });
  it('restores interrupted publishing as uncertain without making another remote request', async () => {
    const f = await fixture([
      savedRecord(1, {
        status: 'publishing',
        remoteId: null,
        publishedAt: null,
        postKey: request.postKey,
      }),
    ]);
    expect((await f.controller.state()).publications[0].status).toBe('uncertain');
    expect(f.getSaved()?.records[0].status).toBe('uncertain');
    await f.controller.publish(request, 'post');
    expect(f.client.publishContainer).not.toHaveBeenCalled();
    expect(f.client.createContainer).not.toHaveBeenCalled();
  });
  it('retains durable publishing intent if saving the successful response fails', async () => {
    const f = await fixture();
    const write = f.history.write.getMockImplementation()!;
    f.history.write.mockImplementation(async (value) => {
      if (value.records.some((record) => record.status === 'published'))
        throw new SecretStoreError('storage');
      await write(value);
    });
    expect((await f.controller.publish(request, 'post')).status).toBe('error');
    expect(f.client.publishContainer).toHaveBeenCalledTimes(1);
    expect(f.getSaved()?.records[0].status).toBe('publishing');
    expect((await f.restart().state()).publications[0].status).toBe('uncertain');
  });
  it('uses the API-published root ID for replies and does not upload media again', async () => {
    const f = await fixture([savedRecord(1, { postKey: request.postKey, remoteId: '7654321' })]);
    const result = await f.controller.publish(
      { ...request, expectedCommentUpdatedAt: AT },
      'reply',
    );
    expect(result.status).toBe('ok');
    expect(f.client.createContainer).toHaveBeenCalledExactlyOnceWith(TOKEN, '123', {
      media_type: 'TEXT',
      text: 'Approved reply\nhttps://example.test/product',
      reply_to_id: '7654321',
    });
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.options.prepareMedia).not.toHaveBeenCalled();
    expect(f.getSaved()?.records.at(-1)).toMatchObject({
      kind: 'reply',
      parentRemoteId: '7654321',
      remoteId: '9000',
    });
  });
  it('does not cross library identity after folder moves or DB restores', async () => {
    const f = await fixture([savedRecord(1, { postKey: request.postKey })]);
    f.view.snapshot!.root = '/moved-library';
    expect(await f.controller.publish(request, 'post')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_duplicate' },
    });
    f.view.snapshot!.libraryId = 'd'.repeat(32);
    expect((await f.controller.state()).publications).toEqual([]);
    expect((await f.controller.publish(request, 'post')).status).toBe('ok');
  });
  it('requires recovery if account credentials exist but the API history is missing', async () => {
    const f = await fixture();
    f.setSaved(null);
    expect((await f.controller.state()).problem?.code).toBe('threads_history_missing');
    await f.controller.publish(request, 'post');
    expect(f.client.createContainer).not.toHaveBeenCalled();
  });
  it('cancels before any durable operation or network write when confirmation is declined', async () => {
    const f = await fixture();
    vi.mocked(f.options.confirm).mockResolvedValueOnce(false);
    expect(await f.controller.publish(request, 'post')).toEqual({ status: 'cancelled' });
    expect(f.history.write).not.toHaveBeenCalled();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
  });
});

describe('replies to app-published root posts', () => {
  const replyRequest = { ...request, expectedCommentUpdatedAt: AT };

  it('targets our matching published root despite other accounts, libraries, and reply records', async () => {
    const f = await fixture([
      savedRecord(1, { postKey: request.postKey, accountId: '999' }),
      savedRecord(2, { postKey: request.postKey, libraryId: 'd'.repeat(32) }),
      savedRecord(3, { kind: 'reply', parentRemoteId: '1001', postKey: 'source:another' }),
      savedRecord(4, {
        kind: 'reply',
        postKey: request.postKey,
        parentRemoteId: '7777',
        status: 'failed',
        remoteId: null,
        publishedAt: null,
      }),
      savedRecord(5, { postKey: request.postKey, remoteId: '7654321' }),
    ]);
    expect((await f.controller.publish(replyRequest, 'reply')).status).toBe('ok');
    expect(f.client.createContainer).toHaveBeenCalledExactlyOnceWith(TOKEN, '123', {
      media_type: 'TEXT',
      text: 'Approved reply\nhttps://example.test/product',
      reply_to_id: '7654321',
    });
    expect(f.getSaved()?.records.at(-1)).toMatchObject({
      kind: 'reply',
      parentRemoteId: '7654321',
      commentUpdatedAt: AT,
      media: [],
      childIds: [],
    });
    expect(f.client.createContainer.mock.calls.flat()).not.toContain(f.post.postId);
  });

  it.each([
    'missing',
    'failed',
    'uncertain',
    'other_account',
    'other_library',
    'reply_only',
    'stale_comment',
  ] as const)('rejects a %s parent/comment without a remote write', async (issue) => {
    const parent = savedRecord(1, { postKey: request.postKey });
    if (issue === 'failed' || issue === 'uncertain' || issue === 'reply_only') {
      parent.status = issue === 'uncertain' ? 'uncertain' : 'failed';
      parent.remoteId = null;
      parent.publishedAt = null;
    }
    if (issue === 'other_account') parent.accountId = '999';
    if (issue === 'other_library') parent.libraryId = 'd'.repeat(32);
    if (issue === 'reply_only') {
      parent.kind = 'reply';
      parent.parentRemoteId = '7777';
    }
    const f = await fixture(issue === 'missing' ? [] : [parent]);
    const input = {
      ...replyRequest,
      ...(issue === 'stale_comment' ? { expectedCommentUpdatedAt: '2026-09-27T12:00:00Z' } : {}),
    };
    expect(await f.controller.publish(input, 'reply')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_reply' },
    });
    expect(f.options.confirm).not.toHaveBeenCalled();
    expect(f.history.write).not.toHaveBeenCalled();
    expect(f.client.createContainer).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect((await f.controller.state()).publishProgress).toBeNull();
  });

  it('reports reply progress, persists success before cleanup, and blocks another reply after restart', async () => {
    const root = savedRecord(1, { postKey: request.postKey, remoteId: '7654321' });
    const f = await fixture([root]);
    const phases: ThreadsPublishProgress['stage'][] = [];
    const capture = async () => {
      const state = await f.controller.state();
      expect(state.busy).toBe(true);
      expect(state.publishProgress).toMatchObject({ postKey: request.postKey, kind: 'reply' });
      const phase = state.publishProgress!.stage;
      if (phases.at(-1) !== phase) phases.push(phase);
    };
    f.options.refresh = vi.fn(async () => {
      await capture();
      return f.view;
    });
    f.options.confirm = vi.fn(async () => {
      await capture();
      return true;
    });
    const originalWrite = f.history.write.getMockImplementation()!;
    f.history.write.mockImplementation(async (value) => {
      await capture();
      await originalWrite(value);
    });
    f.client.createContainer.mockImplementationOnce(async () => {
      await capture();
      return { id: '3001' };
    });
    f.client.publishContainer.mockImplementationOnce(async () => {
      await capture();
      expect(f.getSaved()?.records.at(-1)).toMatchObject({
        kind: 'reply',
        status: 'publishing',
        containerId: '3001',
        parentRemoteId: '7654321',
      });
      return { id: '9000' };
    });
    f.storage.pendingKeys.mockImplementationOnce(async () => {
      await capture();
      expect(f.getSaved()?.records.at(-1)).toMatchObject({
        kind: 'reply',
        status: 'published',
        remoteId: '9000',
        parentRemoteId: '7654321',
        publishedAt: AT,
      });
      return [];
    });
    expect(await f.controller.publish(replyRequest, 'reply')).toMatchObject({
      status: 'ok',
      state: { busy: false, publishProgress: null },
    });
    expect(phases).toEqual([
      'checking',
      'confirming',
      'preparing',
      'processing',
      'publishing',
      'saving',
      'cleaning',
    ]);
    expect(f.getSaved()?.records[0]).toEqual(root);
    expect(f.options.prepareMedia).not.toHaveBeenCalled();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.client.insights).not.toHaveBeenCalled();
    const restarted = f.restart();
    expect((await restarted.state()).publications.at(-1)).toMatchObject({
      kind: 'reply',
      status: 'published',
      remoteId: '9000',
    });
    // Restore the plain read: progress assertions above refer to the completed instance.
    f.options.refresh = vi.fn(async () => f.view);
    expect(await restarted.publish(replyRequest, 'reply')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_duplicate' },
    });
    expect(f.client.createContainer).toHaveBeenCalledTimes(1);
    expect(f.client.publishContainer).toHaveBeenCalledTimes(1);
  });

  it('keeps a timed-out reply uncertain across restart and never resends it automatically', async () => {
    const f = await fixture([savedRecord(1, { postKey: request.postKey, remoteId: '7654321' })]);
    f.client.publishContainer.mockRejectedValueOnce(
      new ThreadsApiError('timeout', { maybeSent: true }),
    );
    expect(await f.controller.publish(replyRequest, 'reply')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_uncertain' },
    });
    expect(f.getSaved()?.records.at(-1)).toMatchObject({
      kind: 'reply',
      status: 'uncertain',
      parentRemoteId: '7654321',
      remoteId: null,
      publishedAt: null,
    });
    const restarted = f.restart();
    await restarted.tick();
    expect(await restarted.publish(replyRequest, 'reply')).toMatchObject({
      status: 'error',
      problem: { code: 'threads_duplicate' },
    });
    expect(f.client.createContainer).toHaveBeenCalledTimes(1);
    expect(f.client.publishContainer).toHaveBeenCalledTimes(1);
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect((await restarted.state()).publishProgress).toBeNull();
  });
});

describe('publication progress', () => {
  it('reports the actual mixed-media phases, saves success before cleaning, and clears runtime progress', async () => {
    const f = await fixture();
    const videoId = 'd'.repeat(32);
    f.post.attachments.push({
      ...f.post.attachments[0],
      mediaId: videoId,
      kind: 'video',
      ordinal: 2,
    });
    f.post.draft!.mediaIds.push(videoId);
    const originalPrepare = f.options.prepareMedia;
    const phases: ThreadsPublishProgress[] = [];
    const capture = async () => {
      const state = await f.controller.state();
      expect(state.busy).toBe(true);
      expect(state.publishProgress).toMatchObject({ postKey: request.postKey, kind: 'post' });
      phases.push(state.publishProgress!);
    };
    f.options.refresh = vi.fn(async () => {
      await capture();
      return f.view;
    });
    f.options.confirm = vi.fn(async () => {
      await capture();
      return true;
    });
    f.options.prepareMedia = vi.fn<ThreadsPublishingOptions['prepareMedia']>(async (...args) => {
      await capture();
      const [image] = await originalPrepare(...args);
      return [
        image,
        { ...image, mediaId: videoId, kind: 'video', contentType: 'video/mp4', extension: 'mp4' },
      ];
    });
    const originalUpload = f.storage.upload.getMockImplementation()!;
    f.storage.upload.mockImplementation(async (...args) => {
      await capture();
      return originalUpload(...args);
    });
    let container = 3000;
    f.client.createContainer.mockImplementation(async () => {
      await capture();
      return { id: String(++container) };
    });
    f.client.publishContainer.mockImplementation(async () => {
      await capture();
      expect(f.getSaved()!.records[0].status).toBe('publishing');
      return { id: '9000' };
    });
    const originalWrite = f.history.write.getMockImplementation()!;
    f.history.write.mockImplementation(async (value) => {
      if (value.records[0]?.status === 'published') await capture();
      await originalWrite(value);
    });
    f.storage.pendingKeys.mockImplementation(async () => {
      await capture();
      expect(f.getSaved()!.records[0]).toMatchObject({ status: 'published', remoteId: '9000' });
      return [];
    });
    expect(await f.controller.publish(request, 'post')).toMatchObject({
      status: 'ok',
      state: { publishProgress: null, busy: false },
    });
    expect(phases.map((p) => p.stage)).toEqual([
      'checking',
      'confirming',
      'preparing',
      'uploading',
      'processing',
      'uploading',
      'processing',
      'processing',
      'publishing',
      'saving',
      'cleaning',
    ]);
    expect(phases.filter((p) => p.stage === 'uploading')).toEqual([
      {
        postKey: request.postKey,
        kind: 'post',
        stage: 'uploading',
        mediaKind: 'image',
        current: 1,
        total: 2,
      },
      {
        postKey: request.postKey,
        kind: 'post',
        stage: 'uploading',
        mediaKind: 'video',
        current: 2,
        total: 2,
      },
    ]);
    expect((await f.controller.state()).publishProgress).toBeNull();
    expect(JSON.stringify(f.getSaved())).not.toContain('publishProgress');
    expect(f.client.insights).not.toHaveBeenCalled();
  });
  it.each(['cancelled', 'failed'] as const)(
    'clears progress when a publication is %s',
    async (outcome) => {
      const f = await fixture();
      const choice = deferred<boolean>();
      f.options.confirm = vi.fn(() => choice.promise);
      if (outcome === 'failed')
        f.storage.upload.mockRejectedValueOnce(new FileServerError('file_server_auth'));
      const pending = f.controller.publish(request, 'post');
      await vi.waitFor(() => expect(f.options.confirm).toHaveBeenCalledOnce());
      expect((await f.controller.state()).publishProgress).toEqual({
        postKey: request.postKey,
        kind: 'post',
        stage: 'confirming',
      });
      choice.resolve(outcome !== 'cancelled');
      expect((await pending).status).toBe(outcome === 'cancelled' ? 'cancelled' : 'error');
      expect((await f.controller.state()).publishProgress).toBeNull();
      expect(f.client.publishContainer).not.toHaveBeenCalled();
    },
  );
});

describe('uncertain publication reconciliation', () => {
  it.each(['different_owner', 'invalid_time'])(
    'rejects %s without binding the wrong remote post',
    async (issue) => {
      const item = savedRecord(1, {
        status: 'uncertain',
        remoteId: null,
        publishedAt: null,
        text: 'Approved main text',
      });
      const f = await fixture([item]);
      f.client.containerStatus.mockResolvedValueOnce({
        id: item.containerId!,
        status: 'PUBLISHED',
      });
      f.client.retrieveMedia.mockResolvedValueOnce({
        id: '8000',
        text: item.text,
        permalink: null,
        username: 'owner',
        timestamp: issue === 'invalid_time' ? 'not-a-time' : AT,
        mediaType: 'IMAGE',
        ownerId: issue === 'different_owner' ? '999' : '123',
        isReply: false,
        repliedToId: null,
      });
      expect(await f.controller.reconcile({ id: item.id, remoteId: '8000' })).toMatchObject({
        status: 'error',
        problem: { code: 'threads_reconcile_mismatch' },
      });
      expect(f.getSaved()?.records[0].status).toBe('uncertain');
      expect(f.client.publishContainer).not.toHaveBeenCalled();
    },
  );
  it('links a verified published result without sending another publish request', async () => {
    const item = savedRecord(1, {
      status: 'uncertain',
      remoteId: null,
      publishedAt: null,
      text: 'Approved main text',
    });
    const f = await fixture([item]);
    f.client.containerStatus.mockResolvedValueOnce({
      id: item.containerId!,
      status: 'PUBLISHED',
    });
    expect((await f.controller.reconcile({ id: item.id, remoteId: '8000' })).status).toBe('ok');
    expect(f.getSaved()?.records[0]).toMatchObject({ status: 'published', remoteId: '8000' });
    expect(f.client.publishContainer).not.toHaveBeenCalled();
  });
});

describe('recent publication insights', () => {
  it('uses only the newest five successful root posts for the connected account', async () => {
    const records = Array.from({ length: 8 }, (_, index) => savedRecord(index + 1));
    records.push(savedRecord(9, { kind: 'reply', parentRemoteId: '1008' }));
    records.push(savedRecord(10, { accountId: '456' }));
    records.push(savedRecord(11, { status: 'failed', remoteId: null, publishedAt: null }));
    const f = await fixture(records);
    expect((await f.controller.sync()).status).toBe('ok');
    expect(f.client.insights.mock.calls.map((call) => call)).toEqual(
      ['1008', '1007', '1006', '1005', '1004'].map((id) => [TOKEN, id]),
    );
    expect(f.client.retrieveMedia).not.toHaveBeenCalled();
    expect(f.client.createContainer).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
  });
  it('shares concurrent sync work, runs automatically once per day, and permits explicit same-day sync', async () => {
    const f = await fixture([savedRecord(1)]);
    const pending = deferred<{ views: number; likes: number; replies: number }>();
    f.client.insights.mockReturnValueOnce(pending.promise);
    const first = f.controller.sync();
    const second = f.controller.sync();
    await vi.waitFor(() => expect(f.client.insights).toHaveBeenCalledTimes(1));
    await f.controller.tick();
    pending.resolve({ views: 100, likes: 5, replies: 2 });
    await Promise.all([first, second]);
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledTimes(1);
    await f.controller.sync();
    expect(f.client.insights).toHaveBeenCalledTimes(2);
    f.advance(1);
    await f.controller.tick();
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledTimes(3);
  });
  it('waits until the next local 10:00 slot after a new publication instead of querying immediately', async () => {
    const f = await fixture();
    const publishedAt = new Date(2026, 8, 28, 13).getTime();
    f.setNow(publishedAt);
    expect((await f.controller.publish(request, 'post')).status).toBe('ok');
    await f.controller.tick();
    await f.restart().tick();
    f.setNow(new Date(2026, 8, 29, 9, 59, 59).getTime());
    await f.controller.tick();
    expect(f.client.insights).not.toHaveBeenCalled();
    expect(f.getSaved()!.sync).toEqual({});
    f.setNow(new Date(2026, 8, 29, 10).getTime());
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '9000');
    await f.restart().tick();
    expect(f.client.insights).toHaveBeenCalledTimes(1);
  });
  it('uses local clock boundaries and performs only one scheduled attempt despite repeated ticks or restart', async () => {
    const yesterday = new Date(2026, 8, 27, 10).toISOString();
    const f = await fixture([savedRecord(1, { createdAt: yesterday, publishedAt: yesterday })]);
    f.setSaved({
      version: 1,
      records: f.getSaved()!.records,
      sync: { '123': { attemptedAt: yesterday, succeededAt: yesterday, retryAt: null } },
    });
    f.setNow(new Date(2026, 8, 28, 9, 59, 59).getTime());
    await f.controller.tick();
    expect(f.accounts.credentials).not.toHaveBeenCalled();
    expect(f.client.insights).not.toHaveBeenCalled();
    f.setNow(new Date(2026, 8, 28, 10).getTime());
    await f.controller.tick();
    await f.controller.tick();
    await f.restart().tick();
    expect(f.client.insights).toHaveBeenCalledTimes(1);
    f.setNow(new Date(2026, 8, 29, 10).getTime());
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledTimes(2);
  });
  it('catches up only posts published before the elapsed slot while leaving newer posts for tomorrow', async () => {
    const early = new Date(2026, 8, 28, 8).toISOString();
    const late = new Date(2026, 8, 28, 11).toISOString();
    const f = await fixture([
      savedRecord(1, { createdAt: early, publishedAt: early }),
      savedRecord(2, { createdAt: late, publishedAt: late }),
    ]);
    f.setNow(new Date(2026, 8, 28, 12).getTime());
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '1001');
    await f.restart().tick();
    expect(f.client.insights).toHaveBeenCalledTimes(1);
    f.setNow(new Date(2026, 8, 29, 10).getTime());
    await f.controller.tick();
    expect(f.client.insights.mock.calls).toEqual([
      [TOKEN, '1001'],
      [TOKEN, '1002'],
      [TOKEN, '1001'],
    ]);
  });
  it.each([9, 11])(
    'queries on app startup at %i:00 and skips the scheduled attempt and subsequent restarts that day',
    async (hour) => {
      const earlier = new Date(2026, 8, 27, 12).toISOString();
      const f = await fixture([savedRecord(1, { createdAt: earlier, publishedAt: earlier })]);
      f.setNow(new Date(2026, 8, 28, hour).getTime());
      await f.controller.tick(true);
      expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '1001');
      f.setNow(new Date(2026, 8, 28, 12).getTime());
      await f.controller.tick();
      await f.restart().tick(true);
      expect(f.client.insights).toHaveBeenCalledTimes(1);
      f.setNow(new Date(2026, 8, 29, 9, 59, 59).getTime());
      await f.controller.tick();
      expect(f.client.insights).toHaveBeenCalledTimes(1);
      f.setNow(new Date(2026, 8, 29, 10).getTime());
      await f.controller.tick();
      expect(f.client.insights).toHaveBeenCalledTimes(2);
    },
  );
  it('does not let an empty startup or a publication trigger statistics; before-slot posts become eligible at 10', async () => {
    const f = await fixture();
    f.setNow(new Date(2026, 8, 28, 9).getTime());
    await f.controller.tick(true);
    expect(f.accounts.credentials).not.toHaveBeenCalled();
    expect((await f.controller.publish(request, 'post')).status).toBe('ok');
    await f.controller.tick();
    expect(f.client.insights).not.toHaveBeenCalled();
    f.setNow(new Date(2026, 8, 28, 10).getTime());
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '9000');
  });
  it('allows a real later startup to query an existing post when there has been no query that day', async () => {
    const f = await fixture();
    f.setNow(new Date(2026, 8, 28, 13).getTime());
    await f.controller.tick(true);
    expect((await f.controller.publish(request, 'post')).status).toBe('ok');
    await f.controller.tick();
    expect(f.client.insights).not.toHaveBeenCalled();
    await f.restart().tick(true);
    expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '9000');
  });
  it('does not retry a failed automatic attempt within the same local date, including restart', async () => {
    const earlier = new Date(2026, 8, 27, 12).toISOString();
    const f = await fixture([savedRecord(1, { createdAt: earlier, publishedAt: earlier })]);
    f.client.insights.mockRejectedValueOnce(new ThreadsApiError('auth_expired'));
    f.setNow(new Date(2026, 8, 28, 9).getTime());
    await f.controller.tick(true);
    f.setNow(new Date(2026, 8, 28, 11).getTime());
    await f.controller.tick();
    await f.restart().tick(true);
    expect(f.client.insights).toHaveBeenCalledTimes(1);
    f.setNow(new Date(2026, 8, 29, 10).getTime());
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledTimes(2);
  });
  it('retains explicit manual refresh for a post newer than the scheduled slot', async () => {
    const publishedAt = new Date(2026, 8, 28, 11).toISOString();
    const f = await fixture([savedRecord(1, { createdAt: publishedAt, publishedAt })]);
    f.setNow(new Date(2026, 8, 28, 11).getTime());
    await f.controller.tick();
    expect(f.client.insights).not.toHaveBeenCalled();
    expect(f.accounts.credentials).not.toHaveBeenCalled();
    expect((await f.controller.sync()).status).toBe('ok');
    expect(f.client.insights).toHaveBeenCalledExactlyOnceWith(TOKEN, '1001');
    await f.controller.tick();
    expect(f.client.insights).toHaveBeenCalledTimes(1);
  });
  it('keeps cached metrics on partial null values or an authentication failure', async () => {
    const records = [savedRecord(1), savedRecord(2)];
    const f = await fixture(records);
    f.client.insights.mockResolvedValueOnce({ views: 100, likes: null, replies: 2 } as unknown as {
      views: number;
      likes: number;
      replies: number;
    });
    f.client.insights.mockRejectedValueOnce(new ThreadsApiError('auth_expired'));
    expect((await f.controller.sync()).status).toBe('error');
    for (const record of f.getSaved()!.records) {
      expect(record.metrics).toEqual({ views: 40, likes: 2, replies: 1 });
      expect(record.metricsUpdatedAt).toBe('2026-09-27T12:00:00.000Z');
      expect(record.metricsProblem).not.toBeNull();
    }
    expect((await f.controller.state()).lastSyncAt).toBeNull();
  });
  it('stops on a rate limit and honors server retry time even for manual refresh', async () => {
    const f = await fixture([savedRecord(1), savedRecord(2)]);
    f.client.insights.mockRejectedValueOnce(
      new ThreadsApiError('rate_limited', { retryAfterSeconds: 120 }),
    );
    expect((await f.controller.sync()).status).toBe('error');
    expect(f.client.insights).toHaveBeenCalledTimes(1);
    expect(await f.controller.sync()).toMatchObject({
      status: 'error',
      problem: { code: 'threads_rate_limit' },
    });
    expect(f.client.insights).toHaveBeenCalledTimes(1);
  });
  it('makes no insights request if persisting the attempt fails', async () => {
    const f = await fixture([savedRecord(1)]);
    f.history.write.mockRejectedValueOnce(new SecretStoreError('storage'));
    expect((await f.controller.sync()).status).toBe('error');
    expect(f.client.insights).not.toHaveBeenCalled();
  });
});

describe('file server connection settings', () => {
  it('saves and disconnects locally without publishing or changing existing publication history', async () => {
    const f = await fixture([savedRecord(1)]);
    const before = f.getSaved();
    const input = { connectionCode: 'synthetic-connection-code' };
    expect(await f.controller.connectFileServer(input)).toMatchObject({
      status: 'ok',
      state: { fileServer: { server: 'https://tfs.ilscp.net', savedAt: AT } },
    });
    expect(f.storage.connect).toHaveBeenCalledExactlyOnceWith(input);
    expect((await f.controller.disconnectFileServer()).status).toBe('ok');
    expect(f.storage.disconnect).toHaveBeenCalledExactlyOnceWith();
    expect(f.storage.upload).not.toHaveBeenCalled();
    expect(f.client.createContainer).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
    expect(f.getSaved()).toEqual(before);
  });
  it('blocks connection replacement and disconnection while a publication is active', async () => {
    const f = await fixture();
    const choice = deferred<boolean>();
    f.options.confirm = vi.fn(() => choice.promise);
    const publication = f.controller.publish(request, 'post');
    await vi.waitFor(() => expect(f.options.confirm).toHaveBeenCalledOnce());
    expect(await f.controller.connectFileServer({ connectionCode: 'replacement' })).toMatchObject({
      status: 'error',
      problem: { code: 'threads_busy' },
    });
    expect(await f.controller.disconnectFileServer()).toMatchObject({
      status: 'error',
      problem: { code: 'threads_busy' },
    });
    expect(f.storage.connect).not.toHaveBeenCalled();
    expect(f.storage.disconnect).not.toHaveBeenCalled();
    choice.resolve(false);
    expect(await publication).toEqual({ status: 'cancelled' });
  });
  it('reports revoked file server credentials and stops before any Threads write', async () => {
    const f = await fixture();
    f.storage.upload.mockRejectedValueOnce(new FileServerError('file_server_auth'));
    expect(await f.controller.publish(request, 'post')).toMatchObject({
      status: 'error',
      problem: { code: 'file_server_auth' },
    });
    expect(f.client.createContainer).not.toHaveBeenCalled();
    expect(f.client.publishContainer).not.toHaveBeenCalled();
    expect(f.getSaved()?.records[0].status).toBe('failed');
  });
});

it('publishes a retained registered post after source removal and preserves its API history after local removal', async () => {
  const f = await fixture();
  f.post.sourceDeleted = true;
  f.post.downloadExcluded = true;
  expect((await f.controller.publish(request, 'post')).status).toBe('ok');
  expect(f.options.prepareMedia).toHaveBeenCalledOnce();
  expect(f.getSaved()?.records[0]).toMatchObject({ remoteId: '9000', status: 'published' });
  f.view.snapshot!.posts = [];
  const state = await f.restart().state();
  expect(state.publications).toEqual(
    expect.arrayContaining([expect.objectContaining({ remoteId: '9000', status: 'published' })]),
  );
  expect(f.client.publishContainer).toHaveBeenCalledOnce();
});
