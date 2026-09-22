import { execFile, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionView, Post } from '../shared/contracts';
import { validPostDraftActionInput } from '../shared/post-export';
import { ViewError } from './collection';
import {
  launchPostDraftDelete,
  parsePostDraftDeleteResult,
  PostDraftDeleteController,
  type LaunchPostDraftDelete,
} from './post-draft-delete';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./python', () => ({ pythonCommand: () => ({ command: 'python', prefix: [] }) }));

const root = '/collection';
const postKey = '["Example","PostA"]';
const input = { postKey, expectedRevision: 1 };

function post(): Post {
  return {
    key: postKey,
    account: 'Example',
    postId: 'PostA',
    originalUrl: 'https://example.test/post',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    caption: '원글',
    captionStatus: 'complete',
    captionObservedAt: null,
    attachmentStatus: 'complete',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: '',
    attachments: [
      {
        ordinal: 1,
        kind: 'image',
        addressStatus: 'missing',
        observedAt: null,
        status: 'review',
        reason: 'local_file_unavailable',
        localUrl: null,
        mediaId: 'a'.repeat(32),
      },
    ],
    draft: {
      caption: '등록 캡션',
      mediaIds: ['a'.repeat(32)],
      revision: 1,
      createdAt: '2026-09-22T01:00:00+00:00',
      updatedAt: '2026-09-22T01:00:00+00:00',
    },
  };
}
function view(item = post()): CollectionView {
  return {
    snapshot: {
      root,
      loadedAt: '2026-09-22T01:00:00+00:00',
      sourceCount: 1,
      posts: [item],
      warnings: [],
      stateStatus: 'read_only',
    },
    error: null,
  };
}
function withoutDraft(): CollectionView {
  const item = post();
  delete item.draft;
  return view(item);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(initial = view()) {
  const refresh = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(withoutDraft());
  const confirm = vi.fn().mockResolvedValue(true);
  const cancel = vi.fn();
  const launch = vi.fn<LaunchPostDraftDelete>(() => ({ result: Promise.resolve(), cancel }));
  const busy = vi.fn(() => false);
  return {
    refresh,
    confirm,
    cancel,
    launch,
    busy,
    controller: new PostDraftDeleteController(refresh, confirm, launch, busy),
  };
}

describe('registered post deletion', () => {
  it('deletes references despite missing source media and keeps the original post and attachments', async () => {
    const { controller, confirm, launch } = setup();
    const result = await controller.delete(root, input);
    expect(result).toEqual({ status: 'deleted', view: withoutDraft() });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal));
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root, kind: 'delete', ...input });
    expect(controller.active).toBe(false);
  });
  it.each([
    null,
    {},
    { ...input, expectedRevision: 0 },
    { ...input, caption: 'untrusted' },
    { ...input, expectedRevision: 1.5 },
  ])('rejects malformed action %j before confirmation', async (bad) => {
    const { controller, refresh, confirm, launch } = setup();
    expect(validPostDraftActionInput(bad)).toBe(false);
    expect(await controller.delete(root, bad)).toMatchObject({
      status: 'error',
      problem: { code: 'draft_input' },
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
  it('rejects changed revisions and damaged draft metadata before confirmation', async () => {
    for (const code of ['draft_conflict', 'drafts_unavailable', 'deletion_recovery_required']) {
      const current = view();
      if (code === 'draft_conflict') current.snapshot!.posts[0].draft!.revision = 2;
      else current.snapshot!.warnings.push({ code, message: 'Check state.' });
      const { controller, confirm, launch } = setup(current);
      expect(await controller.delete(root, input)).toMatchObject({
        status: 'error',
        problem: { code },
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    }
  });
  it('cancels confirmation without starting a worker', async () => {
    const { controller, confirm, launch } = setup();
    confirm.mockResolvedValueOnce(false);
    expect(await controller.delete(root, input)).toEqual({ status: 'cancelled' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('aborts a pending native confirmation and prevents a late acceptance from launching', async () => {
    const decision = deferred<boolean>();
    const { controller, confirm, launch } = setup();
    confirm.mockReturnValueOnce(decision.promise);
    const operation = controller.delete(root, input);
    await Promise.resolve();
    const signal = confirm.mock.calls[0][1] as AbortSignal;
    await controller.shutdown();
    expect(signal.aborted).toBe(true);
    decision.resolve(true);
    expect(await operation).toEqual({ status: 'cancelled' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('blocks duplicate clicks throughout confirmation and honors other app work', async () => {
    const decision = deferred<boolean>();
    const { controller, confirm, launch, busy } = setup();
    busy.mockReturnValueOnce(true);
    expect((await controller.delete(root, input)).status).toBe('error');
    confirm.mockReturnValueOnce(decision.promise);
    const operation = controller.delete(root, input);
    await Promise.resolve();
    expect(await controller.delete(root, input)).toMatchObject({
      status: 'error',
      problem: { code: 'draft_delete_busy' },
    });
    decision.resolve(true);
    await operation;
    expect(launch).toHaveBeenCalledOnce();
  });
  it('retains deletion success if shutdown races with a committed worker receipt', async () => {
    const worker = deferred<void>();
    const started = deferred<void>();
    const { controller, launch, cancel } = setup();
    launch.mockImplementationOnce(() => {
      started.resolve();
      return { result: worker.promise, cancel };
    });
    const operation = controller.delete(root, input);
    await started.promise;
    const finished = vi.fn();
    const shutdown = controller.shutdown().then(finished);
    expect(cancel).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    worker.resolve();
    await shutdown;
    expect((await operation).status).toBe('deleted');
    expect(finished).toHaveBeenCalledOnce();
  });
  it('refreshes after worker failure, preserves the error, and does not retry', async () => {
    const { controller, refresh, launch, cancel } = setup();
    launch.mockReturnValueOnce({
      result: Promise.reject(new ViewError('draft_conflict', 'Updated during confirmation.')),
      cancel,
    });
    expect(await controller.delete(root, input)).toMatchObject({
      status: 'error',
      problem: { code: 'draft_conflict' },
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('does not bring back a deleted draft when refresh fails or returns the old revision', async () => {
    for (const fail of [true, false]) {
      const { controller, refresh } = setup();
      // Explicit ordering keeps the first refresh authoritative.
      refresh.mockReset().mockResolvedValueOnce(view());
      if (fail) refresh.mockRejectedValueOnce(new Error('refresh failed'));
      else refresh.mockResolvedValueOnce(view());
      const result = await controller.delete(root, input);
      expect(result).toMatchObject({
        status: 'deleted',
        view: { error: { code: 'draft_delete_refresh_failed' } },
      });
      if (result.status !== 'deleted') throw new Error('Expected successful receipt');
      expect(result.view.snapshot!.posts[0].draft).toBeUndefined();
      expect(result.view.snapshot!.posts[0].attachments).toEqual(post().attachments);
    }
  });
  it('keeps a newer draft returned by a successful refresh', async () => {
    const newer = post();
    newer.draft!.revision = 2;
    const { controller, refresh } = setup();
    refresh.mockReset().mockResolvedValueOnce(view()).mockResolvedValueOnce(view(newer));
    expect(await controller.delete(root, input)).toEqual({ status: 'deleted', view: view(newer) });
  });
  it('waits for a post-commit refresh during shutdown while keeping the confirmed deletion', async () => {
    const pending = deferred<CollectionView>();
    const refreshing = deferred<void>();
    const { controller, refresh, cancel } = setup();
    refresh
      .mockReset()
      .mockResolvedValueOnce(view())
      .mockImplementationOnce(() => {
        refreshing.resolve();
        return pending.promise;
      });
    const operation = controller.delete(root, input);
    await refreshing.promise;
    const finished = vi.fn();
    const shutdown = controller.shutdown().then(finished);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    expect(finished).not.toHaveBeenCalled();
    pending.resolve(withoutDraft());
    await shutdown;
    expect((await operation).status).toBe('deleted');
  });
});

describe('draft deletion worker boundary', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    'null',
    '{}',
    '{"ok":true}',
    '{"ok":true,"deleted":true,"postKey":"other"}',
    'not json',
  ])('rejects untrusted receipts %s', (raw) =>
    expect(() => parsePostDraftDeleteResult(raw, input)).toThrow(ViewError),
  );
  it('propagates bounded worker errors', () => {
    expect(() =>
      parsePostDraftDeleteResult(
        JSON.stringify({ ok: false, error: { code: 'draft_conflict', message: 'Changed.' } }),
        input,
      ),
    ).toThrow(new ViewError('draft_conflict', 'Changed.'));
  });
  it('serializes the separate delete command and preserves commit proof through cancellation', async () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
    vi.mocked(execFile).mockReturnValueOnce(child as unknown as ChildProcess);
    const command = { root, kind: 'delete' as const, ...input };
    const operation = launchPostDraftDelete('/synthetic-app')(command);
    const call = vi.mocked(execFile).mock.calls.at(-1)!;
    expect(call[1]).toEqual(['-I', '-B', '/synthetic-app/local-runtime/post_draft.py']);
    expect(call[2]).toMatchObject({ timeout: 120_000, maxBuffer: 64 * 1024 });
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual(command);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    const callback = call[3];
    if (typeof callback !== 'function') throw new Error('Missing callback');
    callback(new Error('Exit raced'), JSON.stringify({ ok: true, postKey, deleted: true }), '');
    await expect(operation.result).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(40_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
