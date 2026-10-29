import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionView, Post } from '../shared/contracts';
import type { MobilePublication, SendMobilePublicationInput } from '../shared/mobile-publications';
import { MobilePublicationsController } from './mobile-publications';
import {
  validPublicationJournal,
  type PublicationJournal,
  type PublicationRequest,
} from './mobile-publication-data';
import { ServiceApiError, type ServiceApiClient } from './service-api';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const createdAt = '2026-10-19T01:02:03.123456+00:00';
const mediaId = 'a'.repeat(32);
const key = '["sample","post"]';
function post(): Post {
  return {
    key,
    account: 'sample',
    postId: 'post',
    originalUrl: '',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    caption: 'original',
    captionStatus: 'complete',
    captionObservedAt: null,
    attachmentStatus: 'complete',
    runStatus: 'complete',
    gapStatus: '',
    reasons: [],
    source: 'synthetic',
    attachments: [
      {
        ordinal: 1,
        kind: 'image',
        addressStatus: '',
        observedAt: null,
        status: 'saved',
        reason: null,
        mediaId,
        localUrl: `threads-media://file/${mediaId}`,
      },
    ],
    draft: {
      caption: '준비된 본문',
      mediaIds: [mediaId],
      createdAt,
      updatedAt: createdAt,
      revision: 1,
    },
  };
}
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tmm-publication-test-'));
  roots.push(root);
  const view: CollectionView = {
    error: null,
    snapshot: {
      root,
      libraryId: 'library-a',
      loadedAt: new Date().toISOString(),
      sourceCount: 1,
      stateStatus: 'read_only',
      warnings: [],
      posts: [post()],
    },
  };
  let journal: PublicationJournal | null = null;
  const store = {
    read: vi.fn(async () => structuredClone(journal)),
    write: vi.fn(async (value: PublicationJournal) => {
      if (!validPublicationJournal(value)) throw new Error('invalid journal');
      journal = structuredClone(value);
    }),
  };
  const context = { ownerId: 'employee-a' };
  let authenticated = true;
  const rows: MobilePublication[] = [];
  const account = {
    id: 'account-a',
    ownerId: context.ownerId,
    registrationId: randomUUID(),
    label: 'myaccount',
    appName: 'myapp',
    appId: null,
    threadsUserId: null,
    validationStatus: 'pending_validation',
    tokenRevision: 1,
    expiresAt: null,
    createdAt: new Date().toISOString(),
    lifecycleVersion: 1,
    ownershipVersion: 1,
  };
  let sourceVersion = 0;
  const deletionReceipts = new Map<string, unknown>();
  const client: Pick<
    ServiceApiClient,
    | 'getBusinessContext'
    | 'assertBusinessContext'
    | 'publicationRequest'
    | 'managedThreadsRequest'
    | 'businessSignal'
  > = {
    getBusinessContext: vi.fn(async () => context),
    businessSignal: vi.fn(() => new AbortController().signal),
    assertBusinessContext: vi.fn(() => {
      if (!authenticated) throw new ServiceApiError('로그인 변경', 'AUTH_CHANGED', 401);
    }),
    managedThreadsRequest: vi.fn(async () => ({ accounts: [account] })),
    publicationRequest: vi.fn(async (_context, op, id, raw) => {
      const body = raw as Record<string, unknown>;
      if (op === 'list') return { publications: structuredClone(rows) };
      if (op === 'statuses')
        return {
          statuses: rows
            .filter((p) => p.rootStatus === 'published')
            .map((p) => ({
              postKey: p.source.postKey,
              draftCreatedAt: p.source.draftCreatedAt,
              commentPublished: p.commentStatus === 'published',
            })),
        };
      if (op === 'create') {
        const request = raw as PublicationRequest;
        const existing = rows.find((p) => p.requestId === request.requestId);
        if (existing) return { publication: structuredClone(existing) };
        const p: MobilePublication = {
          id: randomUUID(),
          requestId: request.requestId,
          version: 1,
          accountId: request.accountId,
          source: structuredClone(request.source),
          caption: request.caption,
          comment: request.comment,
          media: structuredClone(request.media),
          status: 'uploading',
          sentAt: null,
          deadlineAt: null,
          rootStatus: 'queued',
          commentStatus: 'not_required',
        };
        rows.push(p);
        sourceVersion += 1;
        return { publication: structuredClone(p) };
      }
      const p = rows.find((p) => p.id === id);
      if (op === 'get') return { publication: structuredClone(p) };
      if (op === 'comment') {
        if (body.expectedVersion !== p!.version)
          throw new ServiceApiError('changed', 'PUBLICATION_CHANGED', 409);
        p!.comment = structuredClone(body.comment) as MobilePublication['comment'];
        p!.commentStatus = 'queued';
        p!.version += 1;
        return { publication: structuredClone(p) };
      }
      if (op === 'upload-urls')
        return {
          uploads: p!.media.map((m) => ({
            mediaId: m.id,
            method: 'PUT',
            url: `https://test-bucket.s3.ap-northeast-2.amazonaws.com/staging/${m.id}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic`,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            headers: {
              'content-type': m.contentType,
              'content-length': String(m.size),
              'x-amz-checksum-sha256': Buffer.from(m.sha256, 'hex').toString('base64'),
              'if-none-match': '*',
            },
          })),
        };
      if (op === 'complete') {
        p!.status = 'ready';
        p!.version += 1;
        p!.sentAt = new Date().toISOString();
        p!.deadlineAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
        return { publication: structuredClone(p) };
      }
      if (op === 'recall') {
        p!.status = 'cancelled';
        p!.version += 1;
        return { publication: structuredClone(p) };
      }
      if (op === 'cancel-request') {
        const found = rows.find((p) => p.requestId === id);
        if (found) found.status = 'cancelled';
        return { requestCancelled: true, publication: structuredClone(found ?? null) };
      }
      if (op === 'source-state')
        return {
          sourceVersion,
          editable: !rows.some((p) => ['ready', 'uploading'].includes(p.status)),
          publications: structuredClone(rows),
        };
      if (op === 'source-deletions') {
        const old = deletionReceipts.get(body.requestId as string);
        if (old) return old;
        if (body.expectedSourceVersion !== sourceVersion)
          throw new ServiceApiError('changed', 'SOURCE_CHANGED', 409);
        const cancelledIds: string[] = [];
        const preservedIds: string[] = [];
        for (const p of rows) {
          if (['uploading', 'ready'].includes(p.status)) {
            p.status = 'cancelled';
            cancelledIds.push(p.id);
          } else preservedIds.push(p.id);
        }
        const receipt = {
          deletion: {
            requestId: body.requestId,
            source: body.source,
            cancelledIds,
            preservedIds,
            completedAt: new Date().toISOString(),
          },
        };
        deletionReceipts.set(body.requestId as string, receipt);
        return receipt;
      }
      throw new Error('unsupported operation');
    }),
  };
  const prepare = vi.fn(async (_root: string, _ids: string[], directory: string) => {
    await mkdir(directory, { recursive: true });
    const path = join(directory, '1.png');
    await writeFile(path, 'converted-png');
    return [
      {
        path,
        mediaId,
        contentType: 'image/png',
        size: 13,
        extension: 'png',
        kind: 'image' as const,
        sha256: 'f'.repeat(64),
      },
    ];
  });
  const upload = vi.fn(async () => {});
  const refresh = vi.fn(async () => structuredClone(view));
  const controller = new MobilePublicationsController({
    client,
    store,
    service: 'https://service.example',
    userData: root,
    refresh,
    libraryId: () => view.snapshot?.libraryId ?? null,
    localBusy: () => false,
    prepareMedia: prepare,
    upload,
  });
  const input: SendMobilePublicationInput = {
    postKey: key,
    expectedRevision: 1,
    expectedDraftCreatedAt: createdAt,
    expectedCommentUpdatedAt: null,
    accountId: 'account-a',
  };
  return {
    controller,
    client,
    store,
    rows,
    view,
    refresh,
    prepare,
    upload,
    input,
    journal: () => journal,
    invalidate: () => {
      authenticated = false;
    },
    advance: () => {
      sourceVersion += 1;
    },
  };
}
describe('desktop publication control plane and durable intent', () => {
  it('syncs a saved reply into the copy the phone can still post, before the local save', async () => {
    const f = await setup();
    const reply = { caption: '나중에 쓴 댓글', link: '' };
    expect(await f.controller.syncComment('library-a', key, reply)).toBeUndefined();
    await f.controller.send(f.input);
    const before = f.rows[0].version;
    vi.mocked(f.client.publicationRequest).mockClear();
    expect(await f.controller.syncComment('library-a', key, reply)).toBe(
      '댓글을 저장하고 휴대폰으로 보낸 등록본에도 반영했습니다.',
    );
    expect(vi.mocked(f.client.publicationRequest).mock.calls.map((c) => c.slice(1))).toEqual([
      ['list', undefined, { libraryId: 'library-a', postKey: key }],
      ['comment', f.rows[0].id, { expectedVersion: before, comment: reply }],
    ]);
    expect(f.rows[0]).toMatchObject({ comment: reply, commentStatus: 'queued' });
    f.rows[0].sentAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    expect(await f.controller.syncComment('library-a', key, reply)).toContain(
      '휴대폰 목록 기간(전송 후 7일)이 지나',
    );
    await expect(
      f.controller.syncComment('library-a', key, { caption: '가'.repeat(501), link: '' }),
    ).rejects.toMatchObject({ code: 'mobile_publication_text' });
    for (const commentStatus of ['sending', 'unknown', 'published']) {
      f.rows[0].commentStatus = commentStatus;
      vi.mocked(f.client.publicationRequest).mockClear();
      await expect(f.controller.syncComment('library-a', key, reply)).rejects.toMatchObject({
        code: 'COMMENT_LOCKED',
      });
      expect(vi.mocked(f.client.publicationRequest).mock.calls.map((c) => c[1])).toEqual(['list']);
    }
    f.rows[0].commentStatus = 'cancelled';
    vi.mocked(f.client.publicationRequest).mockClear();
    expect(await f.controller.syncComment('library-a', key, reply)).toBeUndefined();
    expect(vi.mocked(f.client.publicationRequest).mock.calls.map((c) => c[1])).toEqual(['list']);
    f.rows[0].status = 'cancelled';
    expect(await f.controller.syncComment('library-a', key, reply)).toBeUndefined();
    f.rows[0].status = 'uploading';
    await expect(f.controller.syncComment('library-a', key, reply)).rejects.toMatchObject({
      code: 'mobile_publication_recall_required',
    });
    expect(f.controller.active).toBe(false);
  });
  it('reads published badges for the loaded library without refreshing it or taking the work lock', async () => {
    const f = await setup();
    await f.controller.send(f.input);
    Object.assign(f.rows[0], { rootStatus: 'published', commentStatus: 'published' });
    f.refresh.mockClear();
    vi.mocked(f.client.publicationRequest).mockClear();
    expect(await f.controller.statuses()).toEqual({
      status: 'ok',
      statuses: [{ postKey: key, draftCreatedAt: createdAt, commentPublished: true }],
      problem: null,
    });
    expect(vi.mocked(f.client.publicationRequest).mock.calls).toEqual([
      [{ ownerId: 'employee-a' }, 'statuses', undefined, { libraryId: 'library-a' }],
    ]);
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.controller.active).toBe(false);
    vi.mocked(f.client.publicationRequest).mockResolvedValueOnce({ statuses: [{ postKey: key }] });
    expect(await f.controller.statuses()).toMatchObject({
      status: 'error',
      statuses: [],
      problem: { code: 'INVALID_RESPONSE' },
    });
  });
  it('sends only an immutable manifest with the actual prepared hash and original microsecond source date', async () => {
    const f = await setup();
    const r = await f.controller.send(f.input);
    expect(r.status).toBe('ok');
    expect(r.publications[0].status).toBe('ready');
    expect(f.journal()!.pending).toEqual([]);
    const call = vi.mocked(f.client.publicationRequest).mock.calls.find((c) => c[1] === 'create')!;
    const payload = call[3] as PublicationRequest;
    expect(payload.source.draftCreatedAt).toBe(createdAt);
    expect(payload.media[0].sha256).toBe(
      createHash('sha256').update('converted-png').digest('hex'),
    );
    expect(JSON.stringify(payload)).not.toMatch(/path|token|Bearer|converted-png/);
    expect(f.store.write.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(f.client.publicationRequest).mock.invocationCallOrder[0],
    );
    expect(f.upload).toHaveBeenCalledTimes(1);
  });
  it('exposes pending work after an upload error; reads never retransmit and retry retains request and media IDs', async () => {
    const f = await setup();
    f.upload.mockRejectedValueOnce(new Error('lost upload response'));
    const failed = await f.controller.send(f.input);
    expect(failed.status).toBe('error');
    expect(failed.pending).toHaveLength(1);
    const saved = structuredClone(f.journal()!.pending[0].request);
    vi.mocked(f.client.publicationRequest).mockClear();
    f.upload.mockClear();
    await f.controller.get({ postKey: key });
    expect(vi.mocked(f.client.publicationRequest).mock.calls.map((c) => c[1])).toEqual(['list']);
    expect(f.upload).not.toHaveBeenCalled();
    const retried = await f.controller.retry({ requestId: saved.requestId });
    expect(retried.status).toBe('ok');
    expect(
      vi.mocked(f.client.publicationRequest).mock.calls.find((c) => c[1] === 'create')?.[3],
    ).toEqual(saved);
    expect(f.journal()!.pending).toEqual([]);
  });
  it('retains original failure even if read-only reconciliation also fails', async () => {
    const f = await setup();
    const original = f.client.publicationRequest;
    f.client.publicationRequest = vi.fn<typeof original>(async (...args) => {
      if (['create', 'list'].includes(args[1]))
        throw new ServiceApiError('offline', 'SERVICE_UNAVAILABLE', 503);
      return original(...args);
    });
    const r = await f.controller.send(f.input);
    expect(r.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(r.pending).toHaveLength(1);
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('does not report cancelled, expired or already published snapshots as newly queued', async () => {
    for (const status of ['cancelled', 'expired', 'published', 'started'] as const) {
      const f = await setup();
      f.upload.mockRejectedValueOnce(new Error('fail'));
      await f.controller.send(f.input);
      const requestId = f.journal()!.pending[0].request.requestId;
      f.rows[0].status = status;
      f.upload.mockClear();
      const r = await f.controller.retry({ requestId });
      expect(r.status).toBe('error');
      expect(r.problem?.code).toBe('mobile_publication_existing_state');
      expect(r.publications[0].status).toBe(status);
      expect(f.journal()!.pending).toHaveLength(0);
      expect(f.upload).not.toHaveBeenCalled();
    }
  });
  it('never clears durable intent from a response with a conflicting frozen payload', async () => {
    const f = await setup();
    f.upload.mockRejectedValueOnce(new Error('fail'));
    await f.controller.send(f.input);
    f.rows[0].status = 'ready';
    f.rows[0].caption = 'other';
    const r = await f.controller.get({ postKey: key });
    expect(r.status).toBe('error');
    expect(f.journal()!.pending).toHaveLength(1);
  });
  it('rechecks source revisions after both first preparation and retry preparation', async () => {
    const f = await setup();
    const prepare = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (...args) => {
      const files = await prepare(...args);
      f.view.snapshot!.posts[0].draft!.revision += 1;
      return files;
    });
    expect((await f.controller.send(f.input)).problem?.code).toBe('mobile_publication_changed');
    expect(f.journal()).toBeNull();
    expect(vi.mocked(f.client.publicationRequest).mock.calls.some((c) => c[1] === 'create')).toBe(
      false,
    );
    const second = await setup();
    second.upload.mockRejectedValueOnce(new Error('fail'));
    await second.controller.send(second.input);
    const retryId = second.journal()!.pending[0].request.requestId;
    const prep = second.prepare.getMockImplementation()!;
    second.prepare.mockImplementationOnce(async (...args) => {
      const files = await prep(...args);
      second.view.snapshot!.posts[0].draft!.revision += 1;
      return files;
    });
    vi.mocked(second.client.publicationRequest).mockClear();
    expect((await second.controller.retry({ requestId: retryId })).problem?.code).toBe(
      'mobile_publication_changed',
    );
    expect(
      vi.mocked(second.client.publicationRequest).mock.calls.some((c) => c[1] === 'create'),
    ).toBe(false);
  });
  it('stops before complete and does not disclose pending metadata after an auth change during upload', async () => {
    const f = await setup();
    f.upload.mockImplementationOnce(async () => {
      f.invalidate();
    });
    const r = await f.controller.send(f.input);
    expect(r.problem?.code).toBe('AUTH_CHANGED');
    expect(r.pending).toEqual([]);
    expect(vi.mocked(f.client.publicationRequest).mock.calls.some((c) => c[1] === 'complete')).toBe(
      false,
    );
    expect(f.journal()!.pending).toHaveLength(1);
  });
  it('requires a confirmed request-scoped cancellation before removing a pending request', async () => {
    const f = await setup();
    f.upload.mockRejectedValueOnce(new Error('fail'));
    await f.controller.send(f.input);
    const requestId = f.journal()!.pending[0].request.requestId;
    const r = await f.controller.cancelPending({ requestId });
    expect(r.status).toBe('ok');
    expect(f.journal()!.pending).toHaveLength(0);
    expect(f.rows[0].status).toBe('cancelled');
  });
  it('rejects another employee request and unknown IPC fields without a mutation', async () => {
    const f = await setup();
    expect((await f.controller.send({ ...f.input, token: 'forged' })).status).toBe('error');
    expect((await f.controller.retry({ requestId: randomUUID() })).status).toBe('error');
    expect(f.client.managedThreadsRequest).not.toHaveBeenCalled();
    expect(f.upload).not.toHaveBeenCalled();
  });
  it('passes explicit task closure to the API and retains its unknown result in history', async () => {
    const f = await setup();
    await f.controller.send(f.input);
    f.rows[0].status = 'started';
    f.rows[0].rootStatus = 'unknown';
    const item = f.rows[0];
    const closed = await f.controller.recall({
      publicationId: item.id,
      expectedVersion: item.version,
      abandonUnresolved: true,
    });
    expect(closed.status).toBe('ok');
    expect(closed.publications[0]).toMatchObject({ status: 'cancelled', rootStatus: 'unknown' });
    expect(f.client.publicationRequest).toHaveBeenCalledWith(
      expect.anything(),
      'recall',
      item.id,
      expect.objectContaining({ abandonUnresolved: true }),
    );
    const calls = vi.mocked(f.client.publicationRequest).mock.calls.length;
    expect(
      (
        await f.controller.recall({
          publicationId: item.id,
          expectedVersion: item.version,
          abandonUnresolved: 'true',
        })
      ).status,
    ).toBe('error');
    expect(vi.mocked(f.client.publicationRequest).mock.calls.length).toBe(calls);
  });
  it('requires recall before draft/comment edits, but preserves completed snapshots while editing a new local revision', async () => {
    const f = await setup();
    await f.controller.send(f.input);
    await expect(f.controller.requireEditable('library-a', key)).rejects.toMatchObject({
      code: 'mobile_publication_recall_required',
    });
    f.rows[0].status = 'published';
    await expect(f.controller.requireEditable('library-a', key)).resolves.toBeUndefined();
    expect(f.rows[0].status).toBe('published');
  });
  it('reuses a durable deletion request after a lost response and clears its receipt only after local commit', async () => {
    const f = await setup();
    await f.controller.send(f.input);
    const original = f.client.publicationRequest;
    let lose = true;
    f.client.publicationRequest = vi.fn<typeof original>(async (...args) => {
      const response = await original(...args);
      if (args[1] === 'source-deletions' && lose) {
        lose = false;
        throw new ServiceApiError('offline', 'SERVICE_UNAVAILABLE', 503);
      }
      return response;
    });
    await expect(
      f.controller.beforeDelete('library-a', f.view.snapshot!.posts[0]),
    ).rejects.toThrow();
    const requestId = f.journal()!.deletions[0].requestId;
    expect(f.rows[0].status).toBe('cancelled');
    await f.controller.beforeDelete('library-a', f.view.snapshot!.posts[0]);
    const calls = vi
      .mocked(f.client.publicationRequest)
      .mock.calls.filter((c) => c[1] === 'source-deletions');
    expect(calls.map((c) => (c[3] as { requestId: string }).requestId)).toEqual([
      requestId,
      requestId,
    ]);
    expect(f.journal()!.deletions).toHaveLength(1);
    await f.controller.afterDelete('library-a', f.view.snapshot!.posts[0]);
    expect(f.journal()!.deletions).toHaveLength(0);
  });
  it('does not silently adopt a newer source version after a deletion conflict', async () => {
    const f = await setup();
    const original = f.client.publicationRequest;
    let race = true;
    f.client.publicationRequest = vi.fn<typeof original>(async (...args) => {
      if (args[1] === 'source-deletions' && race) {
        race = false;
        f.advance();
      }
      return original(...args);
    });
    await expect(
      f.controller.beforeDelete('library-a', f.view.snapshot!.posts[0]),
    ).rejects.toMatchObject({ code: 'SOURCE_CHANGED' });
    expect(f.journal()!.deletions).toHaveLength(0);
    expect(
      vi.mocked(f.client.publicationRequest).mock.calls.filter((c) => c[1] === 'source-deletions'),
    ).toHaveLength(1);
  });
});
