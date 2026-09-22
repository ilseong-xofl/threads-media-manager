import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CollectionView, MediaEditInput, Post } from '../shared/contracts';
import { postExportIssue } from '../shared/post-export';
import { parseRuntimeResult, ViewError } from './collection';
import { MediaRegistry } from './media';
import {
  MediaEditController,
  launchMediaEdit,
  parseMediaEditInput,
  parseMediaEditResult,
  type LaunchMediaEdit,
} from './media-edit';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./python', () => ({
  pythonCommand: () => ({ command: 'mock-python-never-executed', prefix: [] }),
}));

const sourceId = 'a'.repeat(32);
const savedId = 'b'.repeat(32);
const postKey = 'demo:PostA';
const input = (): MediaEditInput => ({
  postKey,
  mediaId: sourceId,
  kind: 'crop',
  crop: { x: 1, y: 2, width: 100, height: 80 },
});
const png = (width = 1, height = 1) => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
    'base64',
  );
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return new Uint8Array(bytes);
};
const capture = (): MediaEditInput => ({
  postKey,
  mediaId: sourceId,
  kind: 'capture',
  png: png(),
  time: 1.25,
});
const trim = (): MediaEditInput => ({
  postKey,
  mediaId: sourceId,
  kind: 'trim',
  start: 1.25,
  end: 8.75,
});
function post(): Post {
  return {
    key: postKey,
    account: 'demo',
    postId: 'PostA',
    originalUrl: '',
    caption: 'Original caption',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    captionObservedAt: null,
    captionStatus: 'complete',
    attachmentStatus: 'partial',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: 'results/2026/09/threads-2026-09-22.xlsx',
    attachments: [
      {
        ordinal: 1,
        kind: 'image',
        addressStatus: 'http_candidate',
        observedAt: null,
        status: 'saved',
        reason: null,
        mediaId: sourceId,
        localUrl: `threads-media://file/${sourceId}`,
      },
    ],
  };
}
function view(item = post()): CollectionView {
  return {
    snapshot: {
      root: '/collection',
      loadedAt: '2026-09-22',
      sourceCount: 1,
      posts: [item],
      warnings: [],
      stateStatus: 'read_only',
    },
    error: null,
  };
}
function videoView(): CollectionView {
  const item = post();
  item.attachments[0].kind = 'video';
  return view(item);
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
  const cancel = vi.fn();
  const launch = vi.fn<LaunchMediaEdit>(() => ({ result: Promise.resolve(savedId), cancel }));
  const busy = vi.fn(() => false);
  return {
    refresh,
    launch,
    cancel,
    busy,
    controller: new MediaEditController(refresh, launch, busy),
  };
}

describe('media edit input boundary', () => {
  it('preserves fractional trim times and strips caller paths, duration and codec choices', () => {
    expect(
      parseMediaEditInput({
        ...trim(),
        root: '/outside',
        path: '/outside/video.mp4',
        duration: 100,
        codec: 'unsafe',
      }),
    ).toEqual(trim());
    expect(parseMediaEditInput({ ...trim(), start: 0 })).toMatchObject({ start: 0 });
  });

  it.each([
    { start: -0.1 },
    { start: NaN },
    { start: Infinity },
    { start: '1' },
    { end: Infinity },
    { end: NaN },
    { end: 0 },
    { end: 1.25 },
    { end: null },
  ])('rejects nonfinite, nonnumeric, negative or empty trim ranges: %j', (invalid) => {
    expect(() => parseMediaEditInput({ ...trim(), ...invalid })).toThrow(ViewError);
  });
  it('copies valid crop fields and discards caller paths and unrelated metadata', () => {
    const request = input();
    expect(
      parseMediaEditInput({
        ...request,
        root: '/outside',
        destination: '/outside/file',
        caption: 'secret',
      }),
    ).toEqual(request);
    expect(parseMediaEditInput(request)).not.toBe(request);
  });

  it.each([
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0.1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 8193, height: 1 },
    { x: 0, y: 0, width: 8192, height: 8192 },
    { x: 8192, y: 0, width: 1, height: 1 },
    { x: 0, y: Number.MAX_SAFE_INTEGER, width: 1, height: 1 },
    { x: 0, y: 0, width: NaN, height: 1 },
  ])('rejects an invalid or oversized crop: %j', (crop) => {
    expect(() => parseMediaEditInput({ ...input(), crop })).toThrow(ViewError);
  });

  it('accepts bounded PNG bytes and makes a copy before asynchronous validation', () => {
    const request = capture();
    const parsed = parseMediaEditInput(request);
    expect(parsed).toEqual(request);
    if (request.kind !== 'capture' || parsed.kind !== 'capture') throw new Error('Capture fixture');
    request.png[0] = 0;
    expect(parsed.png[0]).toBe(137);
  });

  it.each([
    { png: png(8193, 1) },
    { png: png(8192, 8192) },
    { png: new Uint8Array(33) },
    { png: [137, 80, 78, 71] },
    { time: -1 },
    { time: Infinity },
  ])('rejects invalid capture bytes or timestamps: %j', (invalid) => {
    expect(() => parseMediaEditInput({ ...capture(), ...invalid })).toThrow(ViewError);
  });

  it('rejects PNG payloads larger than 64 MiB before copying or encoding them', () => {
    expect(() =>
      parseMediaEditInput({ ...capture(), png: new Uint8Array(64 * 1024 * 1024 + 1) }),
    ).toThrow(ViewError);
  });

  it.each([
    null,
    {},
    { ...input(), mediaId: '../source.png' },
    { ...input(), postKey: '' },
    { ...input(), kind: 'write' },
  ])('rejects malformed identities or edit kinds', (invalid) => {
    expect(() => parseMediaEditInput(invalid)).toThrow(ViewError);
  });
});

describe('media edit process ownership', () => {
  it('sends the exact trimmed-video range only after resolving its saved source in the current post', async () => {
    const { controller, launch, refresh } = setup(videoView());
    expect(
      (await controller.save('/collection', { ...trim(), path: '/outside.mp4', root: '/outside' }))
        .status,
    ).toBe('saved');
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root: '/collection', ...trim() });
    expect(refresh.mock.calls).toEqual([['/collection'], ['/collection']]);
  });

  it('allows an existing saved trimmed video to be trimmed again', async () => {
    const current = videoView();
    const item = current.snapshot!.posts[0];
    item.edits = [
      {
        ...item.attachments[0],
        ordinal: 2,
        mediaId: savedId,
        localUrl: `threads-media://file/${savedId}`,
        editType: 'trim',
        sourceMediaId: sourceId,
        createdAt: '2026-09-22T12:00:00+09:00',
      },
    ];
    const { controller, launch } = setup(current);
    expect((await controller.save('/collection', { ...trim(), mediaId: savedId })).status).toBe(
      'saved',
    );
    expect(launch.mock.calls[0][0].mediaId).toBe(savedId);
  });

  it.each(['image', 'missing', 'changed', 'another-post'] as const)(
    'rejects %s trim sources before launching ffmpeg',
    async (reason) => {
      const current = videoView();
      const item = current.snapshot!.posts[0];
      if (reason === 'image') item.attachments[0].kind = 'image';
      if (reason === 'missing') item.attachments[0].localUrl = null;
      if (reason === 'changed') item.attachments[0].status = 'review';
      if (reason === 'another-post') item.key = 'other:PostB';
      const { controller, launch } = setup(current);
      expect(await controller.save('/collection', trim())).toMatchObject({
        status: 'error',
        problem: { code: 'edit_source' },
      });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('keeps a worker range/duration error without retrying or reporting a saved trim', async () => {
    const { controller, launch, cancel, refresh } = setup(videoView());
    launch.mockReturnValueOnce({
      result: Promise.reject(new ViewError('invalid_trim', 'Outside video duration.')),
      cancel,
    });
    expect(await controller.save('/collection', trim())).toEqual({
      status: 'error',
      problem: { code: 'invalid_trim', message: 'Outside video duration.' },
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('refreshes the fixed root, saves one source in that post, and returns the refreshed view', async () => {
    const { refresh, launch, controller } = setup();
    const request = input();
    const result = await controller.save('/collection', {
      ...request,
      root: '/outside',
      destination: '/outside',
    });
    expect(result).toEqual({ status: 'saved', mediaId: savedId, view: view() });
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root: '/collection', ...request });
    expect(refresh.mock.calls).toEqual([['/collection'], ['/collection']]);
    expect(controller.active).toBe(false);
  });

  it('sends capture bytes as base64 only after identifying the saved video source', async () => {
    const item = post();
    item.attachments[0].kind = 'video';
    const { launch, controller } = setup(view(item));
    expect((await controller.save('/collection', capture())).status).toBe('saved');
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      root: '/collection',
      postKey,
      mediaId: sourceId,
      kind: 'capture',
      pngBase64: Buffer.from(png()).toString('base64'),
      time: 1.25,
    });
  });

  it('allows a saved image edit in the same post to be cropped again', async () => {
    const item = post();
    item.edits = [
      {
        ...item.attachments[0],
        ordinal: 2,
        mediaId: savedId,
        localUrl: `threads-media://file/${savedId}`,
        editType: 'crop',
        sourceMediaId: sourceId,
        createdAt: '2026-09-22T12:00:00+09:00',
      },
    ];
    const { controller, launch } = setup(view(item));
    expect((await controller.save('/collection', { ...input(), mediaId: savedId })).status).toBe(
      'saved',
    );
    expect(launch.mock.calls[0][0].mediaId).toBe(savedId);
  });

  it.each(['root', 'post', 'missing', 'changed', 'kind'] as const)(
    'refuses an unavailable or changed %s before launch',
    async (reason) => {
      const current = view();
      if (reason === 'root') current.snapshot!.root = '/other';
      if (reason === 'post') current.snapshot!.posts[0].key = 'another:PostB';
      if (reason === 'missing') current.snapshot!.posts[0].attachments[0].localUrl = null;
      if (reason === 'changed') current.snapshot!.posts[0].attachments[0].status = 'review';
      if (reason === 'kind') current.snapshot!.posts[0].attachments[0].kind = 'video';
      const { controller, launch } = setup(current);
      expect(await controller.save('/collection', input())).toMatchObject({
        status: 'error',
        problem: { code: 'edit_source' },
      });
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each(['crop', 'trim'] as const)(
    'blocks another operation and duplicate %s saves before preflight or worker launch',
    async (kind) => {
      const request = kind === 'trim' ? trim() : input();
      const pending = deferred<string>();
      const { refresh, launch, busy, cancel, controller } = setup(
        kind === 'trim' ? videoView() : view(),
      );
      busy.mockReturnValueOnce(true);
      expect(await controller.save('/collection', request)).toMatchObject({
        status: 'error',
        problem: { code: 'edit_busy' },
      });
      expect(refresh).not.toHaveBeenCalled();
      launch.mockReturnValueOnce({ result: pending.promise, cancel });
      const first = controller.save('/collection', request);
      expect(controller.active).toBe(true);
      expect(await controller.save('/other', request)).toMatchObject({
        status: 'error',
        problem: { code: 'edit_busy' },
      });
      expect(launch).toHaveBeenCalledOnce();
      pending.resolve(savedId);
      expect((await first).status).toBe('saved');
      expect(refresh).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['read-error', 'wrong-root', 'missing-snapshot'] as const)(
    'keeps a committed trim saved if its follow-up refresh has %s',
    async (failure) => {
      const { controller, refresh, launch } = setup(videoView());
      const after = videoView();
      if (failure === 'read-error') after.error = { code: 'read_failed', message: 'Failed.' };
      if (failure === 'wrong-root') after.snapshot!.root = '/other';
      if (failure === 'missing-snapshot') after.snapshot = null;
      refresh.mockResolvedValueOnce(videoView()).mockResolvedValueOnce(after);
      expect(await controller.save('/collection', trim())).toMatchObject({
        status: 'saved',
        mediaId: savedId,
        view: { snapshot: { root: '/collection' }, error: { code: 'edit_refresh_failed' } },
      });
      expect(launch).toHaveBeenCalledOnce();
    },
  );

  it.each(['returned-error', 'rejection'] as const)(
    'reports an already committed edit as saved when refresh has a %s',
    async (failure) => {
      const { controller, refresh, launch } = setup();
      if (failure === 'returned-error')
        refresh.mockResolvedValueOnce(view()).mockResolvedValueOnce({
          ...view(),
          error: { code: 'read_failed', message: 'Read failed.' },
        });
      else refresh.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error('Refresh failed'));
      expect(await controller.save('/collection', input())).toMatchObject({
        status: 'saved',
        mediaId: savedId,
        view: { error: { code: 'edit_refresh_failed' } },
      });
      expect(launch).toHaveBeenCalledOnce();
      expect(controller.active).toBe(false);
    },
  );

  it('propagates a worker failure without retry or a post-save refresh', async () => {
    const { controller, launch, refresh, cancel } = setup();
    launch.mockImplementationOnce(() => ({
      result: Promise.reject(new ViewError('invalid_image', 'Invalid saved image.')),
      cancel,
    }));
    expect(await controller.save('/collection', input())).toEqual({
      status: 'error',
      problem: { code: 'invalid_image', message: 'Invalid saved image.' },
    });
    expect(launch).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
  });

  it.each(['crop', 'trim'] as const)(
    'cancels and waits for the live %s worker to finish cleanup on shutdown',
    async (kind) => {
      const pending = deferred<string>();
      const { controller, launch, refresh, cancel } = setup(kind === 'trim' ? videoView() : view());
      launch.mockReturnValueOnce({ result: pending.promise, cancel });
      const saving = controller.save('/collection', kind === 'trim' ? trim() : input());
      await Promise.resolve();
      const settled = vi.fn();
      const shutdown = controller.shutdown().then(settled);
      expect(cancel).toHaveBeenCalledOnce();
      expect(controller.active).toBe(true);
      expect(settled).not.toHaveBeenCalled();
      pending.reject(new ViewError('cancelled', 'Stopped'));
      await shutdown;
      expect(await saving).toMatchObject({ status: 'error', problem: { code: 'edit_cancelled' } });
      expect(controller.active).toBe(false);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );

  it('does not launch a worker after shutdown during the source refresh', async () => {
    const pending = deferred<CollectionView>();
    const { controller, launch, refresh } = setup();
    refresh.mockReturnValueOnce(pending.promise);
    const saving = controller.save('/collection', input());
    const shutdown = controller.shutdown();
    pending.resolve(view());
    await shutdown;
    expect(await saving).toMatchObject({ status: 'error', problem: { code: 'edit_cancelled' } });
    expect(launch).not.toHaveBeenCalled();
  });

  it('waits for the final refresh and preserves saved status when shutdown races with a committed edit', async () => {
    const pending = deferred<CollectionView>();
    const refreshing = deferred<void>();
    const { controller, refresh, cancel } = setup();
    refresh.mockResolvedValueOnce(view()).mockImplementationOnce(() => {
      refreshing.resolve();
      return pending.promise;
    });
    const saving = controller.save('/collection', input());
    await refreshing.promise;
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    expect(cancel).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
    pending.resolve(view());
    await shutdown;
    expect(await saving).toMatchObject({ status: 'saved', mediaId: savedId });
    expect(controller.active).toBe(false);
  });
});

describe('edit worker and collection response boundary', () => {
  it('returns only the validated saved ID and retains structured worker errors', () => {
    expect(
      parseMediaEditResult(
        JSON.stringify({ ok: true, mediaId: savedId, path: '/private/internal' }),
      ),
    ).toBe(savedId);
    expect(() =>
      parseMediaEditResult(
        '{"ok":false,"error":{"code":"invalid_image","message":"Cannot read image."}}',
      ),
    ).toThrow(new ViewError('invalid_image', 'Cannot read image.'));
  });

  it.each([
    'not json',
    '{}',
    '{"ok":true,"mediaId":"../image.png"}',
    '{"ok":false,"error":{"code":"../path","message":"bad"}}',
  ])('rejects malformed result %s', (raw) =>
    expect(() => parseMediaEditResult(raw)).toThrow(ViewError),
  );

  it('accepts optional separate edits and blocks ZIP export when an edited file is unavailable', () => {
    const current = view();
    const item = current.snapshot!.posts[0];
    expect(
      parseRuntimeResult(JSON.stringify({ ok: true, ...current, files: [] }), '/collection')
        .snapshot.posts[0].edits,
    ).toBeUndefined();
    item.edits = [
      {
        ...item.attachments[0],
        ordinal: 2,
        mediaId: savedId,
        localUrl: `threads-media://file/${savedId}`,
        editType: 'crop',
        sourceMediaId: sourceId,
        createdAt: '2026-09-22T12:00:00+09:00',
      },
    ];
    expect(
      parseRuntimeResult(JSON.stringify({ ok: true, ...current, files: [] }), '/collection')
        .snapshot.posts[0].edits,
    ).toEqual(item.edits);
    expect(postExportIssue(item)).toBeNull();
    item.edits[0].status = 'unavailable';
    expect(postExportIssue(item)).not.toBeNull();
    expect(item.attachments[0].status).toBe('saved');
  });

  it.each([
    { editType: 'unknown' },
    { sourceMediaId: '../source' },
    { createdAt: 'invalid' },
    { createdAt: undefined },
    { localUrl: 'https://remote.invalid/image.png' },
  ])('rejects invalid edited-attachment metadata: %j', (invalid) => {
    const current = view();
    const item = current.snapshot!.posts[0];
    const edit = {
      ...item.attachments[0],
      editType: 'crop',
      sourceMediaId: sourceId,
      createdAt: '2026-09-22T12:00:00+09:00',
      ...invalid,
    };
    const snapshot = { ...current.snapshot, posts: [{ ...item, edits: [edit] }] };
    expect(() =>
      parseRuntimeResult(JSON.stringify({ ok: true, snapshot, files: [] }), '/collection'),
    ).toThrow(ViewError);
  });
});

describe('trim process limits without starting a real process', () => {
  function launchMock(request: MediaEditInput) {
    const child = { kill: vi.fn(), stdin: { on: vi.fn(), end: vi.fn() } };
    vi.mocked(execFile).mockReturnValue(child as unknown as ChildProcess);
    if (request.kind === 'capture') throw new Error('Use a non-capture fixture');
    const operation = launchMediaEdit('/synthetic-app')({
      root: '/synthetic-collection',
      ...request,
    });
    const call = vi.mocked(execFile).mock.calls.at(-1)!;
    const callback = call[3];
    if (typeof callback !== 'function') throw new Error('Missing execFile callback');
    return { child, operation, options: call[2], finish: callback };
  }
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('keeps trim alive past the image limit, then enforces 32 minutes and a finite cleanup window', async () => {
    vi.useFakeTimers();
    const { child, operation, options, finish } = launchMock(trim());
    const failed = operation.result.catch((error) => error);
    expect(options).toMatchObject({ timeout: 1_920_000 });
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual({
      root: '/synthetic-collection',
      ...trim(),
    });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    finish(
      new Error('Timed out'),
      '{"ok":false,"error":{"code":"trim_timeout","message":"Encoding timed out."}}',
      '',
    );
    expect(await failed).toMatchObject({ code: 'trim_timeout' });
  });

  it('stops a long trim immediately on cancel and preserves an already committed success', async () => {
    vi.useFakeTimers();
    const { child, operation, finish } = launchMock(trim());
    operation.cancel();
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    finish(
      new Error('Exit raced with cancellation'),
      JSON.stringify({ ok: true, mediaId: savedId }),
      '',
    );
    await expect(operation.result).resolves.toBe(savedId);
    await vi.advanceTimersByTimeAsync(2_000_000);
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('retains the shorter two-minute watchdog for image edits', async () => {
    vi.useFakeTimers();
    const { child, operation, options, finish } = launchMock(input());
    expect(options).toMatchObject({ timeout: 120_000 });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    finish(null, JSON.stringify({ ok: true, mediaId: savedId }), '');
    await expect(operation.result).resolves.toBe(savedId);
  });
});

const temporaryRoots: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
it('allows canvas CORS only for verified registered local GET responses, including ranges', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tmm-edit-cors-')));
  temporaryRoots.push(root);
  const relativePath = `media/files/${'c'.repeat(32)}/${sourceId}.png`;
  await mkdir(join(root, 'media/files', 'c'.repeat(32)), { recursive: true });
  const bytes = Buffer.from(png());
  await writeFile(join(root, relativePath), bytes);
  const registry = new MediaRegistry();
  await registry.adopt(root, [
    {
      id: sourceId,
      relativePath,
      kind: 'image',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    },
  ]);
  const url = `threads-media://file/${sourceId}`;
  for (const request of [new Request(url), new Request(url, { headers: { range: 'bytes=0-7' } })]) {
    const response = await registry.respond(request);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await response.arrayBuffer();
  }
  for (const request of [
    new Request(url, { method: 'HEAD' }),
    new Request(url, { method: 'POST' }),
    new Request(`threads-media://file/${savedId}`),
  ]) {
    const response = await registry.respond(request);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  }
});
