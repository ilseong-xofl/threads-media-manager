import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC,
  type CollectionView,
  type Post,
  type PostComment,
  type ThreadsMediaApi,
} from '../shared/contracts';
import { ViewError } from './collection';
import {
  PostCommentController,
  launchPostComment,
  parsePostCommentInput,
  parsePostCommentResult,
  type LaunchPostComment,
} from './post-comment';
import '../preload';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./python', () => ({
  pythonCommand: () => ({ command: 'mock-python-never-executed', prefix: [] }),
}));
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));

const root = '/synthetic-collection';
const postKey = 'demo:PostA';
const input = () => ({
  postKey,
  caption: 'A comment\n두 번째 줄 🌿',
  link: 'https://example.test/path?q=hello#section',
});
const comment = (): PostComment => ({
  caption: input().caption,
  link: input().link,
  updatedAt: '2026-09-22T10:00:00.123456+00:00',
});
function post(): Post {
  return {
    key: postKey,
    account: 'demo',
    postId: 'PostA',
    originalUrl: '',
    caption: 'Original source caption',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    captionObservedAt: null,
    captionStatus: 'complete',
    attachmentStatus: 'partial',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: 'results/synthetic.xlsx',
    attachments: [],
    draft: {
      caption: 'Registered caption',
      mediaIds: ['a'.repeat(32)],
      createdAt: '2026-09-22T09:00:00Z',
      updatedAt: '2026-09-22T09:00:00Z',
      revision: 1,
    },
  };
}
function view(saved = false): CollectionView {
  const item = post();
  if (saved) item.comment = comment();
  return {
    snapshot: {
      root,
      loadedAt: '2026-09-22',
      sourceCount: 1,
      posts: [item],
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
  const refresh = vi.fn().mockResolvedValue(view(true)).mockResolvedValueOnce(initial);
  const cancel = vi.fn();
  const launch = vi.fn<LaunchPostComment>(() => ({ result: Promise.resolve(comment()), cancel }));
  const busy = vi.fn(() => false);
  return {
    refresh,
    cancel,
    launch,
    busy,
    controller: new PostCommentController(refresh, launch, busy),
  };
}

describe('comment input boundary', () => {
  it('trims both fields and sends only the selected post and the user text', () => {
    expect(
      parsePostCommentInput({
        ...input(),
        caption: ` \n${input().caption}\t `,
        link: ` ${input().link} `,
        root: '/outside',
        path: '/outside/db',
        updatedAt: 'forged',
      }),
    ).toEqual(input());
    expect(
      parsePostCommentInput({ ...input(), caption: ' \n ', link: 'https://example.test' }),
    ).toEqual({ postKey, caption: '', link: 'https://example.test' });
    expect(parsePostCommentInput({ ...input(), link: ' \n ' })).toEqual({ ...input(), link: '' });
  });
  it('accepts caption and link at their exact UTF-16 size limits', () => {
    const prefix = 'https://example.test/';
    expect(
      parsePostCommentInput({
        ...input(),
        caption: '🌿'.repeat(5000),
        link: prefix + 'a'.repeat(2048 - prefix.length),
      }).caption.length,
    ).toBe(10000);
  });
  it.each([
    null,
    {},
    { ...input(), postKey: '' },
    { ...input(), postKey: 'a'.repeat(513) },
    { ...input(), caption: null },
    { ...input(), caption: ' ', link: '\n' },
    { ...input(), caption: '🌿'.repeat(5001) },
    { ...input(), link: 'https://example.test/' + 'a'.repeat(2048) },
    { ...input(), caption: 'caption\u0000hidden' },
    { ...input(), caption: 'caption\u007fhidden' },
  ])('rejects invalid, empty or oversized inputs', (value) => {
    expect(() => parsePostCommentInput(value)).toThrow(ViewError);
  });
  it.each([
    'example.test/path',
    '/relative/path',
    'javascript:alert(1)',
    'file:///private/file',
    'https:example.test',
    'https:///example.test',
    'https://',
    'https://user:secret@example.test',
    'https://@example.test',
    'https://example.test/path with space',
    'https://example.test/\npath',
    'https://example.test\\other',
    'https://example.test:invalid',
  ])('rejects non-absolute, credentialed, or malformed links: %s', (link) => {
    expect(() => parsePostCommentInput({ ...input(), link })).toThrow(ViewError);
  });
  it('keeps valid HTTP(S) link spelling, fragments and query strings', () => {
    const link = 'HTTPS://Example.test:443/path?q=one%20two#part';
    expect(parsePostCommentInput({ ...input(), link }).link).toBe(link);
  });
});

describe('comment worker result boundary', () => {
  it('validates the selected post and saved text, then discards unrelated result fields', () => {
    expect(
      parsePostCommentResult(
        JSON.stringify({ ok: true, postKey, comment: { ...comment(), path: '/private/db' }, root }),
        input(),
      ),
    ).toEqual(comment());
    expect(() =>
      parsePostCommentResult(
        '{"ok":false,"error":{"code":"comment_locked","message":"Locked."}}',
        input(),
      ),
    ).toThrow(new ViewError('comment_locked', 'Locked.'));
  });
  it.each([
    { postKey: 'other:PostB' },
    { comment: { ...comment(), caption: 'Different' } },
    { comment: { ...comment(), link: 'https://another.test' } },
    { comment: { ...comment(), updatedAt: '2026-09-22' } },
    { comment: { ...comment(), updatedAt: 'not a date' } },
    { comment: { ...comment(), updatedAt: '2026-99-99T00:00:00Z' } },
  ])('rejects mismatched receipts and malformed timestamps', (changed) => {
    expect(() =>
      parsePostCommentResult(
        JSON.stringify({ ok: true, postKey, comment: comment(), ...changed }),
        input(),
      ),
    ).toThrow(ViewError);
  });
});

describe('comment process ownership', () => {
  it('refreshes the trusted root and saves only normalized text for the current post', async () => {
    const { controller, refresh, launch } = setup();
    expect(
      await controller.save(root, { ...input(), root: '/outside', path: 'untrusted' }),
    ).toEqual({ status: 'saved', comment: comment(), view: view(true) });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root, ...input() });
    expect(refresh.mock.calls).toEqual([[root], [root]]);
    expect(controller.active).toBe(false);
  });
  it.each([
    'root',
    'post',
    'read-error',
    'recovery',
    'comments-unavailable',
    'drafts-unavailable',
  ] as const)('rejects invalid %s before launching a write', async (reason) => {
    const initial = view();
    if (reason === 'root') initial.snapshot!.root = '/other';
    if (reason === 'post') initial.snapshot!.posts = [];
    if (reason === 'read-error') initial.error = { code: 'read_failed', message: 'Failed.' };
    if (reason === 'recovery')
      initial.snapshot!.warnings.push({
        code: 'deletion_recovery_required',
        message: 'Recovery needed.',
      });
    if (reason === 'comments-unavailable')
      initial.snapshot!.warnings.push({
        code: 'comments_unavailable',
        message: 'Unknown existing comment.',
      });
    if (reason === 'drafts-unavailable')
      initial.snapshot!.warnings.push({
        code: 'drafts_unavailable',
        message: 'Unknown existing registration.',
      });
    const { controller, launch } = setup(initial);
    expect((await controller.save(root, input())).status).toBe('error');
    expect(launch).not.toHaveBeenCalled();
  });
  it.each(['missing', 'invalid'] as const)(
    'requires a valid registration before saving a comment: %s',
    async (state) => {
      const initial = view();
      if (state === 'missing') delete initial.snapshot!.posts[0].draft;
      else initial.snapshot!.posts[0].draft!.revision = 0;
      const { controller, launch } = setup(initial);
      expect(await controller.save(root, input())).toMatchObject({
        status: 'error',
        problem: { code: 'comment_draft_missing' },
      });
      expect(launch).not.toHaveBeenCalled();
    },
  );
  it('saves comments on registered posts with missing source files without changing the draft', async () => {
    const initial = view();
    initial.snapshot!.posts[0].attachments = [
      {
        ordinal: 1,
        kind: 'image',
        addressStatus: '',
        observedAt: null,
        status: 'review',
        reason: 'local_file_unavailable',
        mediaId: 'a'.repeat(32),
        localUrl: null,
      },
    ];
    const after = structuredClone(initial);
    after.snapshot!.posts[0].comment = comment();
    const { controller, refresh, launch } = setup(initial);
    refresh.mockReset().mockResolvedValueOnce(initial).mockResolvedValueOnce(after);
    expect(await controller.save(root, input())).toEqual({
      status: 'saved',
      comment: comment(),
      view: after,
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root, ...input() });
    expect(after.snapshot!.posts[0].draft).toEqual(initial.snapshot!.posts[0].draft);
    expect(initial.snapshot!.posts[0].comment).toBeUndefined();
  });
  it('blocks other active writes and duplicate saves before preflight and through worker completion', async () => {
    const pending = deferred<PostComment>();
    const { controller, busy, refresh, launch, cancel } = setup();
    busy.mockReturnValueOnce(true);
    expect(await controller.save(root, input())).toMatchObject({
      status: 'error',
      problem: { code: 'comment_busy' },
    });
    expect(refresh).not.toHaveBeenCalled();
    launch.mockReturnValueOnce({ result: pending.promise, cancel });
    const saving = controller.save(root, input());
    expect(await controller.save('/other', input())).toMatchObject({
      status: 'error',
      problem: { code: 'comment_busy' },
    });
    expect(launch).toHaveBeenCalledOnce();
    pending.resolve(comment());
    expect((await saving).status).toBe('saved');
  });
  it('returns the worker error without retrying or changing the original source caption', async () => {
    const initial = view();
    const { controller, launch, cancel, refresh } = setup(initial);
    launch.mockReturnValueOnce({
      result: Promise.reject(
        new ViewError('comments_unavailable', 'Existing comment needs review.'),
      ),
      cancel,
    });
    expect(await controller.save(root, input())).toEqual({
      status: 'error',
      problem: { code: 'comments_unavailable', message: 'Existing comment needs review.' },
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(initial.snapshot!.posts[0].caption).toBe('Original source caption');
    expect(initial.snapshot!.posts[0].comment).toBeUndefined();
  });
  it.each([
    'rejection',
    'read-error',
    'wrong-root',
    'missing-snapshot',
    'missing-comment',
    'stale-comment',
    'same-time-different-values',
  ] as const)('preserves the committed comment in the returned view after %s', async (failure) => {
    const initial = view();
    const { controller, refresh } = setup(initial);
    const after = view(true);
    refresh.mockReset().mockResolvedValueOnce(initial);
    if (failure === 'rejection') refresh.mockRejectedValueOnce(new Error('Read failed'));
    else {
      if (failure === 'read-error') after.error = { code: 'read_failed', message: 'Read failed.' };
      if (failure === 'wrong-root') after.snapshot!.root = '/other';
      if (failure === 'missing-snapshot') after.snapshot = null;
      if (failure === 'missing-comment') delete after.snapshot!.posts[0].comment;
      if (failure === 'stale-comment')
        after.snapshot!.posts[0].comment = { ...comment(), updatedAt: '2026-09-21T10:00:00Z' };
      if (failure === 'same-time-different-values')
        after.snapshot!.posts[0].comment = { ...comment(), caption: 'Stale caption', link: '' };
      refresh.mockResolvedValueOnce(after);
    }
    const result = await controller.save(root, input());
    expect(result).toMatchObject({
      status: 'saved',
      comment: comment(),
      view: { error: { code: 'comment_refresh_failed' }, snapshot: { root } },
    });
    if (result.status !== 'saved') throw new Error('Saved result required');
    expect(result.view.snapshot!.posts[0].comment).toEqual(comment());
    expect(result.view.snapshot!.posts[0].caption).toBe('Original source caption');
    expect(initial.snapshot!.posts[0].comment).toBeUndefined();
  });
  it('does not resurrect a post removed from a successful current snapshot', async () => {
    const { controller, refresh } = setup();
    const after = view();
    after.snapshot!.posts = [];
    refresh.mockReset().mockResolvedValueOnce(view()).mockResolvedValueOnce(after);
    expect(await controller.save(root, input())).toEqual({
      status: 'saved',
      comment: comment(),
      view: after,
    });
  });
  it('cancels preflight without launching a worker', async () => {
    const pending = deferred<CollectionView>();
    const { controller, refresh, launch } = setup();
    refresh.mockReset().mockReturnValueOnce(pending.promise);
    const saving = controller.save(root, input());
    const shutdown = controller.shutdown();
    pending.resolve(view());
    await shutdown;
    expect(await saving).toMatchObject({ status: 'error', problem: { code: 'comment_cancelled' } });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([false, true])(
    'waits for worker cleanup on shutdown, keeping committed=%s outcomes',
    async (committed) => {
      const pending = deferred<PostComment>();
      const { controller, launch, cancel } = setup();
      launch.mockReturnValueOnce({ result: pending.promise, cancel });
      const saving = controller.save(root, input());
      await Promise.resolve();
      const settled = vi.fn();
      const shutdown = controller.shutdown().then(settled);
      expect(cancel).toHaveBeenCalledOnce();
      expect(settled).not.toHaveBeenCalled();
      expect(controller.active).toBe(true);
      if (committed) pending.resolve(comment());
      else pending.reject(new ViewError('cancelled', 'Stopped.'));
      await shutdown;
      expect((await saving).status).toBe(committed ? 'saved' : 'error');
      expect(controller.active).toBe(false);
    },
  );
  it('keeps the operation active until the final refresh ends, even on shutdown', async () => {
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
    const saving = controller.save(root, input());
    await refreshing.promise;
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    expect(cancel).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    expect(await controller.save(root, input())).toMatchObject({
      status: 'error',
      problem: { code: 'comment_busy' },
    });
    pending.resolve(view(true));
    await shutdown;
    expect((await saving).status).toBe('saved');
  });
});

describe('comment preload registration and worker serialization', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it('registers the frozen API and invokes the dedicated IPC channel with one payload', async () => {
    const registration = vi
      .mocked(contextBridge.exposeInMainWorld)
      .mock.calls.find(([name]) => name === 'threadsMedia');
    const api = registration?.[1] as ThreadsMediaApi;
    expect(Object.isFrozen(api)).toBe(true);
    const result = { status: 'saved', comment: comment(), view: view(true) };
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce(result);
    expect(await api.savePostComment(input())).toBe(result);
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(IPC.savePostComment, input());
  });
  it('serializes text through stdin, bounds worker time, and preserves a commit received during cancellation', async () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
    vi.mocked(execFile).mockReturnValue(child as unknown as ChildProcess);
    const operation = launchPostComment('/synthetic-app')({ root, ...input() });
    const call = vi.mocked(execFile).mock.calls.at(-1)!;
    expect(call[1]).toEqual(['-I', '-B', '/synthetic-app/local-runtime/save_post_comment.py']);
    expect(call[2]).toMatchObject({ timeout: 120_000, maxBuffer: 128 * 1024 });
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual({ root, ...input() });
    expect(String(call[1])).not.toContain(input().caption);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    const callback = call[3];
    if (typeof callback !== 'function') throw new Error('Missing callback');
    callback(
      new Error('Exit raced with cancellation'),
      JSON.stringify({ ok: true, postKey, comment: comment() }),
      '',
    );
    await expect(operation.result).resolves.toEqual(comment());
    await vi.advanceTimersByTimeAsync(40_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
