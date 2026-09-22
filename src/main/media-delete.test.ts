import { describe, expect, it, vi } from 'vitest';
import type { CollectionView, MediaDeleteInput, Post } from '../shared/contracts';
import { ViewError } from './collection';
import {
  MediaDeleteController,
  mediaDeleteConfirmation,
  parseMediaDeleteInput,
  parseMediaDeleteResult,
  type LaunchMediaDelete,
  type MediaDeletePlan,
} from './media-delete';

const root = '/collection';
const originalId = 'a'.repeat(32);
const editId = 'b'.repeat(32);
const descendantId = 'c'.repeat(32);
const postKey = 'demo:PostA';
const editInput: MediaDeleteInput = { kind: 'edit', postKey, mediaId: editId };
const postInput: MediaDeleteInput = { kind: 'post', postKey };
const plan = (kind: 'edit' | 'post' = 'edit'): MediaDeletePlan => ({
  fingerprint: 'd'.repeat(64),
  fileCount: kind === 'edit' ? 1 : 3,
  editCount: kind === 'edit' ? 1 : 2,
  account: 'demo',
  postId: 'PostA',
});
function post(): Post {
  const original = {
    ordinal: 1,
    kind: 'image' as const,
    addressStatus: 'http_candidate',
    observedAt: null,
    status: 'saved' as const,
    reason: null,
    mediaId: originalId,
    localUrl: `threads-media://file/${originalId}`,
  };
  return {
    key: postKey,
    account: 'demo',
    postId: 'PostA',
    originalUrl: '',
    caption: '',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    captionObservedAt: null,
    captionStatus: 'complete',
    attachmentStatus: 'partial',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: 'results/example.xlsx',
    attachments: [original],
    edits: [editId, descendantId].map((mediaId, index) => ({
      ...original,
      ordinal: index + 2,
      mediaId,
      localUrl: `threads-media://file/${mediaId}`,
      editType: 'crop',
      sourceMediaId: index ? editId : originalId,
      createdAt: '2026-09-22T12:00:00+09:00',
    })),
  };
}
function view(): CollectionView {
  return {
    snapshot: {
      root,
      loadedAt: '2026-09-22',
      sourceCount: 1,
      posts: [post()],
      warnings: [],
      stateStatus: 'read_only',
    },
    error: null,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup(initial = view()) {
  const refresh = vi.fn().mockResolvedValue(initial);
  const confirm = vi.fn().mockResolvedValue(true);
  const cancel = vi.fn();
  const launch = vi.fn<LaunchMediaDelete>((command) => ({
    result: Promise.resolve(command.command === 'prepare' ? plan(command.kind) : null),
    cancel,
  }));
  const busy = vi.fn(() => false);
  return {
    refresh,
    confirm,
    cancel,
    launch,
    busy,
    controller: new MediaDeleteController(refresh, launch, confirm, busy),
  };
}

describe('deletion input and worker boundaries', () => {
  it('reconstructs only the selected identity, never caller paths or fingerprints', () => {
    expect(
      parseMediaDeleteInput({
        ...editInput,
        root: '/outside',
        fingerprint: 'forged',
        path: '../other',
      }),
    ).toEqual(editInput);
    expect(parseMediaDeleteInput({ ...postInput, mediaId: originalId })).toEqual(postInput);
  });
  it.each([
    null,
    {},
    { kind: 'post', postKey: '' },
    { kind: 'post', postKey: 'x'.repeat(513) },
    { ...editInput, mediaId: '../original.png' },
    { ...editInput, kind: 'original' },
  ])('rejects invalid input %j', (input) => {
    expect(() => parseMediaDeleteInput(input)).toThrow(ViewError);
  });
  it('sanitizes prepare metadata, preserves known worker errors, and validates recovery counts', () => {
    expect(
      parseMediaDeleteResult(
        JSON.stringify({ ok: true, ...plan(), files: ['/private/file'], root }),
        'prepare',
      ),
    ).toEqual(plan());
    expect(parseMediaDeleteResult('{"ok":true}', 'commit')).toBeNull();
    expect(parseMediaDeleteResult('{"ok":true,"recovered":0}', 'recover')).toBeNull();
    expect(() =>
      parseMediaDeleteResult(
        '{"ok":false,"error":{"code":"deletion_changed","message":"Changed."}}',
        'commit',
      ),
    ).toThrow(new ViewError('deletion_changed', 'Changed.'));
    expect(() => parseMediaDeleteResult('{"ok":true}', 'recover')).toThrow(ViewError);
    expect(() => parseMediaDeleteResult('{"ok":true,"recovered":-1}', 'recover')).toThrow(
      ViewError,
    );
  });
  it.each([
    { fingerprint: '../file' },
    { fileCount: -1 },
    { fileCount: 1.1 },
    { editCount: 1_000_001 },
    { account: 'demo\nDifferent account' },
    { postId: '' },
  ])('rejects unsafe or malformed prepare result %j', (invalid) => {
    expect(() =>
      parseMediaDeleteResult(JSON.stringify({ ok: true, ...plan(), ...invalid }), 'prepare'),
    ).toThrow(ViewError);
  });
  it('permits a missing file while deleting its one edited-media record', () => {
    expect(
      parseMediaDeleteResult(JSON.stringify({ ok: true, ...plan(), fileCount: 0 }), 'prepare'),
    ).toEqual({ ...plan(), fileCount: 0 });
  });
});

describe('native deletion confirmation', () => {
  it.each(['edit', 'post'] as const)(
    'defaults %s confirmation to cancel and names the concrete target and file count',
    (kind) => {
      const input = kind === 'edit' ? editInput : postInput;
      const signal = new AbortController().signal;
      const options = mediaDeleteConfirmation(input, plan(kind), signal);
      expect(options).toMatchObject({
        type: 'warning',
        buttons: ['취소', '삭제'],
        defaultId: 0,
        cancelId: 0,
        signal,
      });
      expect(options.detail).toContain('@demo');
      expect(options.detail).toContain('PostA');
      expect(options.detail).toContain(`삭제할 파일: ${plan(kind).fileCount}개`);
      expect(options.detail).toContain(
        kind === 'edit' ? '다른 편집본은 유지' : 'Excel에 삭제 기록',
      );
    },
  );
});

describe('deletion process ownership', () => {
  it.each([editInput, postInput])(
    'prepares and confirms before committing the exact fingerprint for $kind',
    async (input) => {
      const { controller, refresh, launch, confirm } = setup();
      const final = view();
      final.snapshot!.posts = [];
      refresh.mockResolvedValueOnce(view()).mockResolvedValueOnce(final);
      expect(
        await controller.delete(root, { ...input, root: '/outside', fingerprint: 'forged' }),
      ).toEqual({ status: 'deleted', view: final });
      expect(launch.mock.calls.map(([command]) => command)).toEqual([
        { ...input, root, command: 'prepare' },
        { ...input, root, command: 'commit', fingerprint: plan().fingerprint },
      ]);
      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        input,
        plan(input.kind),
        expect.any(AbortSignal),
      );
      expect(confirm.mock.invocationCallOrder[0]).toBeGreaterThan(
        launch.mock.invocationCallOrder[0],
      );
      expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[1]);
      expect(refresh.mock.calls).toEqual([[root], [root]]);
      expect(controller.active).toBe(false);
    },
  );
  it('cancel leaves the commit worker unstarted', async () => {
    const { controller, confirm, launch } = setup();
    confirm.mockResolvedValueOnce(false);
    expect(await controller.delete(root, editInput)).toEqual({ status: 'cancelled' });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ ...editInput, root, command: 'prepare' });
  });
  it.each(['root', 'post', 'original-as-edit', 'unknown-edit'] as const)(
    'rejects a changed or unauthorized %s before worker launch',
    async (reason) => {
      const initial = view();
      let input: MediaDeleteInput = editInput;
      if (reason === 'root') initial.snapshot!.root = '/other';
      if (reason === 'post') initial.snapshot!.posts = [];
      if (reason === 'original-as-edit') input = { ...editInput, mediaId: originalId };
      if (reason === 'unknown-edit') input = { ...editInput, mediaId: 'f'.repeat(32) };
      const { controller, launch, confirm } = setup(initial);
      expect(await controller.delete(root, input)).toMatchObject({
        status: 'error',
        problem: { code: 'delete_source' },
      });
      expect(launch).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
    },
  );
  it.each([{ account: 'other' }, { postId: 'PostB' }, { editCount: 2 }, { fileCount: 2 }])(
    'rejects a prepare scope change before confirmation: %j',
    async (changed) => {
      const { controller, launch, cancel, confirm } = setup();
      launch.mockReturnValueOnce({ result: Promise.resolve({ ...plan(), ...changed }), cancel });
      expect(await controller.delete(root, editInput)).toMatchObject({
        status: 'error',
        problem: { code: 'deletion_changed' },
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(launch).toHaveBeenCalledOnce();
    },
  );
  it('permits removing an edited record whose file was already absent', async () => {
    const { controller, launch, cancel, confirm } = setup();
    launch.mockReturnValueOnce({ result: Promise.resolve({ ...plan(), fileCount: 0 }), cancel });
    expect((await controller.delete(root, editInput)).status).toBe('deleted');
    expect(confirm.mock.calls[0][1].fileCount).toBe(0);
  });
  it('blocks active work and duplicate delete/recover attempts throughout confirmation', async () => {
    const choice = deferred<boolean>();
    const opened = deferred<void>();
    const { controller, busy, refresh, launch, confirm } = setup();
    busy.mockReturnValueOnce(true);
    expect(await controller.delete(root, postInput)).toMatchObject({
      status: 'error',
      problem: { code: 'delete_busy' },
    });
    expect(refresh).not.toHaveBeenCalled();
    confirm.mockImplementationOnce(() => {
      opened.resolve();
      return choice.promise;
    });
    const deleting = controller.delete(root, editInput);
    await opened.promise;
    expect(controller.active).toBe(true);
    expect(await controller.delete(root, postInput)).toMatchObject({
      status: 'error',
      problem: { code: 'delete_busy' },
    });
    expect(await controller.recover(root)).toMatchObject({
      status: 'error',
      problem: { code: 'delete_busy' },
    });
    expect(launch).toHaveBeenCalledOnce();
    choice.resolve(false);
    await deleting;
  });
  it('blocks new deletion when a journal needs recovery', async () => {
    const initial = view();
    initial.snapshot!.warnings.push({
      code: 'deletion_recovery_required',
      message: 'Recovery needed',
    });
    const { controller, launch } = setup(initial);
    expect(await controller.delete(root, postInput)).toMatchObject({
      status: 'error',
      problem: { code: 'deletion_recovery_required' },
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it('refreshes after commit failure so a recovery warning can become visible, without retry', async () => {
    const { controller, launch, cancel, refresh } = setup();
    launch.mockReturnValueOnce({ result: Promise.resolve(plan()), cancel }).mockReturnValueOnce({
      result: Promise.reject(new ViewError('deletion_changed', 'Changed.')),
      cancel,
    });
    expect(await controller.delete(root, editInput)).toEqual({
      status: 'error',
      problem: { code: 'deletion_changed', message: 'Changed.' },
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it.each([editInput, postInput])(
    'preserves successful $kind deletion on refresh failure and removes only its confirmed target from fallback',
    async (input) => {
      const { controller, refresh } = setup();
      refresh.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error('Read failed'));
      const result = await controller.delete(root, input);
      expect(result).toMatchObject({
        status: 'deleted',
        view: { error: { code: 'delete_refresh_failed' } },
      });
      if (result.status !== 'deleted') throw new Error('Expected deleted');
      if (input.kind === 'post') expect(result.view.snapshot!.posts).toEqual([]);
      else {
        expect(result.view.snapshot!.posts[0].attachments[0].mediaId).toBe(originalId);
        expect(result.view.snapshot!.posts[0].edits!.map((item) => item.mediaId)).toEqual([
          descendantId,
        ]);
      }
    },
  );
  it('does not start prepare if shutdown happens during source refresh', async () => {
    const pending = deferred<CollectionView>();
    const { controller, refresh, launch } = setup();
    refresh.mockReturnValueOnce(pending.promise);
    const deleting = controller.delete(root, editInput);
    const shutdown = controller.shutdown();
    pending.resolve(view());
    await shutdown;
    expect(await deleting).toEqual({ status: 'cancelled' });
    expect(launch).not.toHaveBeenCalled();
  });
  it('aborts the native confirmation on shutdown and never launches commit afterwards', async () => {
    const opened = deferred<void>();
    const { controller, confirm, launch } = setup();
    confirm.mockImplementationOnce(
      (_input, _plan, signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          signal.addEventListener('abort', () => resolve(true), { once: true });
          opened.resolve();
        }),
    );
    const deleting = controller.delete(root, editInput);
    await opened.promise;
    await controller.shutdown();
    expect(await deleting).toEqual({ status: 'cancelled' });
    expect(launch).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
  });
  it.each([false, true])(
    'cancels and waits for commit cleanup, preserving success if committed=%s',
    async (committed) => {
      const pending = deferred<MediaDeletePlan | null>();
      const started = deferred<void>();
      const { controller, launch, cancel, refresh } = setup();
      launch
        .mockReturnValueOnce({ result: Promise.resolve(plan()), cancel })
        .mockImplementationOnce(() => {
          started.resolve();
          return { result: pending.promise, cancel };
        });
      const deleting = controller.delete(root, editInput);
      await started.promise;
      const settled = vi.fn();
      const shutdown = controller.shutdown().then(settled);
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(controller.active).toBe(true);
      if (committed) pending.resolve(null);
      else pending.reject(new ViewError('cancelled', 'Cancelled'));
      await shutdown;
      expect((await deleting).status).toBe(committed ? 'deleted' : 'cancelled');
      expect(refresh).toHaveBeenCalledTimes(2);
      expect(controller.active).toBe(false);
    },
  );
  it('runs recovery without a new selection or confirmation and refreshes afterward', async () => {
    const { controller, confirm, launch, refresh } = setup();
    expect(await controller.recover(root)).toEqual({ status: 'deleted', view: view() });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ command: 'recover', root });
    expect(confirm).not.toHaveBeenCalled();
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
  });
  it('keeps recovery success distinct from its failed refresh', async () => {
    const { controller, refresh } = setup();
    refresh.mockRejectedValueOnce(new Error('Read failed'));
    expect(await controller.recover(root)).toMatchObject({
      status: 'deleted',
      view: { error: { code: 'delete_refresh_failed' } },
    });
  });

  it('does not prepare or confirm when source refresh returns an error', async () => {
    const initial = view();
    initial.error = { code: 'source_unavailable', message: 'Unavailable.' };
    const { controller, launch, confirm } = setup(initial);
    expect(await controller.delete(root, postInput)).toMatchObject({
      status: 'error',
      problem: initial.error,
    });
    expect(launch).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it('waits for an in-flight prepare to stop and refresh before shutting down', async () => {
    const prepared = deferred<MediaDeletePlan | null>();
    const { controller, launch, cancel, confirm, refresh } = setup();
    launch.mockReturnValueOnce({ result: prepared.promise, cancel });
    const deleting = controller.delete(root, editInput);
    await Promise.resolve();
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    prepared.resolve(plan());
    await shutdown;
    expect(await deleting).toEqual({ status: 'cancelled' });
    expect(confirm).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('preserves deletion success while shutdown waits for the final refresh', async () => {
    const pending = deferred<CollectionView>();
    const refreshing = deferred<void>();
    const { controller, refresh, cancel } = setup();
    refresh.mockResolvedValueOnce(view()).mockImplementationOnce(() => {
      refreshing.resolve();
      return pending.promise;
    });
    const deleting = controller.delete(root, editInput);
    await refreshing.promise;
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    expect(settled).not.toHaveBeenCalled();
    expect(cancel).not.toHaveBeenCalled();
    pending.resolve(view());
    await shutdown;
    expect((await deleting).status).toBe('deleted');
  });

  it('refreshes after recovery failure to keep unresolved-journal warnings visible', async () => {
    const { controller, launch, cancel, refresh } = setup();
    launch.mockReturnValueOnce({
      result: Promise.reject(new ViewError('deletion_recovery_required', 'Recovery failed.')),
      cancel,
    });
    expect(await controller.recover(root)).toMatchObject({
      status: 'error',
      problem: { code: 'deletion_recovery_required' },
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('cancels and waits for recovery cleanup on shutdown', async () => {
    const pending = deferred<MediaDeletePlan | null>();
    const { controller, launch, cancel, refresh } = setup();
    launch.mockReturnValueOnce({ result: pending.promise, cancel });
    const recovering = controller.recover(root);
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    expect(cancel).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    pending.reject(new ViewError('cancelled', 'Stopped.'));
    await shutdown;
    expect(await recovering).toEqual({ status: 'cancelled' });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
  });
});
