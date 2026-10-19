import { describe, expect, it, vi } from 'vitest';
import type {
  MobilePublication,
  MobilePublicationsResult,
  SendMobilePublicationInput,
} from '../shared/mobile-publications';
import { createMobilePublicationsController } from './use-mobile-publications';

const source = {
  libraryId: 'library-one',
  postKey: 'post-one',
  draftCreatedAt: '2026-10-19T00:00:00.000Z',
  draftRevision: 2,
  commentUpdatedAt: null,
};
const publication: MobilePublication = {
  id: 'publication-one',
  requestId: 'request-one',
  accountId: 'account-one',
  version: 1,
  source,
  status: 'ready',
  caption: 'Saved caption',
  comment: null,
  media: [],
  sentAt: '2026-10-19T01:00:00.000Z',
  deadlineAt: '2026-10-21T01:00:00.000Z',
  rootStatus: 'queued',
  commentStatus: 'none',
};
const sendInput: SendMobilePublicationInput = {
  postKey: source.postKey,
  expectedRevision: source.draftRevision,
  expectedDraftCreatedAt: source.draftCreatedAt,
  expectedCommentUpdatedAt: null,
  accountId: publication.accountId,
};
const ok = (publications: MobilePublication[] = []): MobilePublicationsResult => ({
  status: 'ok',
  publications,
  pending: [],
  problem: null,
});
function setup() {
  const api = {
    getMobilePublications: vi.fn().mockResolvedValue(ok()),
    sendMobilePublication: vi.fn().mockResolvedValue(ok([publication])),
    retryMobilePublication: vi.fn().mockResolvedValue(ok([publication])),
    recallMobilePublication: vi
      .fn()
      .mockResolvedValue(ok([{ ...publication, status: 'cancelled' }])),
    cancelPendingMobilePublication: vi.fn().mockResolvedValue(ok()),
  };
  const effects = { notify: vi.fn(), onWorking: vi.fn() };
  return { api, effects, controller: createMobilePublicationsController(api, effects) };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve: (value: T) => resolve(value),
  };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('mobile publication controller', () => {
  it('reads only after service access is available and never resumes an interrupted send on read', async () => {
    const { api, controller } = setup();
    api.getMobilePublications.mockResolvedValue({
      ...ok(),
      pending: [{ requestId: publication.requestId, accountId: publication.accountId, source }],
    });
    await controller.synchronize();
    await controller.send(sendInput);
    expect(api.getMobilePublications).not.toHaveBeenCalled();
    expect(api.sendMobilePublication).not.toHaveBeenCalled();
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    expect(controller.getSnapshot().pending).toHaveLength(1);
    await controller.synchronize();
    expect(api.getMobilePublications).toHaveBeenCalledTimes(2);
    expect(api.retryMobilePublication).not.toHaveBeenCalled();
    expect(api.cancelPendingMobilePublication).not.toHaveBeenCalled();
  });

  it('sends the exact saved version and target once while preventing duplicate clicks', async () => {
    const { api, controller, effects } = setup();
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    const pending = deferred<MobilePublicationsResult>();
    api.sendMobilePublication.mockReturnValueOnce(pending.promise);
    const sending = controller.send(sendInput);
    expect(controller.getSnapshot().working).toBe(true);
    expect(await controller.send(sendInput)).toBe(false);
    expect(
      await controller.recall({
        publicationId: publication.id,
        expectedVersion: publication.version,
      }),
    ).toBe(false);
    pending.resolve(ok([publication]));
    expect(await sending).toBe(true);
    expect(api.sendMobilePublication).toHaveBeenCalledExactlyOnceWith(sendInput);
    expect(api.recallMobilePublication).not.toHaveBeenCalled();
    expect(effects.onWorking.mock.calls).toEqual([[true], [false]]);
    expect(controller.getSnapshot().working).toBe(false);
    expect(effects.notify).toHaveBeenCalledWith(expect.stringContaining('모바일 게시 대기'));
  });

  it('preserves pending metadata after an ambiguous failure and retries only explicitly', async () => {
    const { api, controller, effects } = setup();
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    api.sendMobilePublication.mockResolvedValue({
      ...ok(),
      status: 'error',
      pending: [{ requestId: publication.requestId, accountId: publication.accountId, source }],
      problem: { code: 'SERVICE_UNAVAILABLE', message: '서버 연결을 확인하세요.' },
    });
    expect(await controller.send(sendInput)).toBe(false);
    expect(controller.getSnapshot().pending).toHaveLength(1);
    expect(api.retryMobilePublication).not.toHaveBeenCalled();
    expect(effects.notify).toHaveBeenCalledWith('서버 연결을 확인하세요.', true);
    await controller.retry(publication.requestId);
    expect(api.retryMobilePublication).toHaveBeenCalledExactlyOnceWith({
      requestId: publication.requestId,
    });
    expect(controller.getSnapshot().pending).toHaveLength(0);
  });

  it('recalls only the confirmed publication version and explicitly cancels an unknown send', async () => {
    const { api, controller } = setup();
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    await controller.recall({ publicationId: publication.id, expectedVersion: 3 });
    expect(api.recallMobilePublication).toHaveBeenCalledExactlyOnceWith({
      publicationId: publication.id,
      expectedVersion: 3,
    });
    await controller.cancelPending(publication.requestId);
    expect(api.cancelPendingMobilePublication).toHaveBeenCalledExactlyOnceWith({
      requestId: publication.requestId,
    });
    expect(api.sendMobilePublication).not.toHaveBeenCalled();
  });

  it('ignores stale results after locking and reconnects by reading without mutation replay', async () => {
    const { api, controller, effects } = setup();
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    const pending = deferred<MobilePublicationsResult>();
    api.sendMobilePublication.mockReturnValueOnce(pending.promise);
    const sending = controller.send(sendInput);
    controller.setContext(source.postKey, source.libraryId, false);
    expect(controller.getSnapshot().publications).toEqual([]);
    controller.setContext(source.postKey, source.libraryId, true);
    pending.resolve(ok([publication]));
    expect(await sending).toBe(false);
    await settle();
    expect(api.getMobilePublications).toHaveBeenCalledTimes(2);
    expect(api.sendMobilePublication).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().publications).toEqual([]);
    expect(effects.notify).not.toHaveBeenCalled();
  });

  it('does not reveal another post or a raw thrown IPC error', async () => {
    const { api, controller, effects } = setup();
    api.getMobilePublications.mockResolvedValue(
      ok([{ ...publication, source: { ...source, postKey: 'another-post' } }]),
    );
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    expect(controller.getSnapshot().publications).toEqual([]);
    expect(await controller.send({ ...sendInput, postKey: 'another-post' })).toBe(false);
    api.sendMobilePublication.mockRejectedValue(new Error('secret-signed-url'));
    expect(await controller.send(sendInput)).toBe(false);
    expect(effects.notify).toHaveBeenCalledWith(
      '모바일 게시 정보를 확인하지 못했습니다. 서버 연결을 확인해 주세요.',
      true,
    );
    expect(JSON.stringify(effects.notify.mock.calls)).not.toContain('secret-signed-url');
  });

  it('clears metadata on an authentication change even if the response contains old records', async () => {
    const { api, controller } = setup();
    api.getMobilePublications.mockResolvedValue({
      ...ok([publication]),
      status: 'error',
      problem: { code: 'AUTH_CHANGED', message: '다시 로그인하세요.' },
    });
    controller.setContext(source.postKey, source.libraryId, true);
    await settle();
    expect(controller.getSnapshot().publications).toEqual([]);
    expect(controller.getSnapshot().loaded).toBe(false);
  });
});
