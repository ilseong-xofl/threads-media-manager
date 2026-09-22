import { describe, expect, it, vi } from 'vitest';
import type { CollectionView, Post } from '../shared/contracts';
import { postExportIssue } from '../shared/post-export';
import { ViewError } from './collection';
import {
  archiveFileName,
  parseExportResult,
  PostExportController,
  type LaunchExport,
} from './post-export';

const root = '/collection';
const postKey = 'example:AbC_01';
const destination = '/exports/AbC_01.zip';

function post(): Post {
  return {
    key: postKey,
    account: 'example',
    postId: 'AbC_01',
    originalUrl: 'https://www.threads.com/@example/post/AbC_01',
    publishedAt: '2026-09-20T10:00:00+09:00',
    collectedAt: '2026-09-21T14:09:00+09:00',
    observedAt: '2026-09-21T14:09:00+09:00',
    caption: 'A caption with a second line.\n한글과 이모지 🌿',
    captionStatus: 'complete',
    captionObservedAt: '2026-09-21T14:09:00+09:00',
    attachmentStatus: 'partial',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: ['attachment_count_unconfirmed'],
    source: 'results/2026/09/threads-2026-09-21.xlsx',
    attachments: [
      {
        ordinal: 1,
        kind: 'image',
        addressStatus: 'observed',
        observedAt: '2026-09-21T14:09:00+09:00',
        status: 'saved',
        reason: null,
        mediaId: 'a'.repeat(32),
        localUrl: `threads-media://file/${'a'.repeat(32)}`,
      },
      {
        ordinal: 2,
        kind: 'video',
        addressStatus: 'observed',
        observedAt: '2026-09-21T14:09:00+09:00',
        status: 'saved',
        reason: null,
        mediaId: 'b'.repeat(32),
        localUrl: `threads-media://file/${'b'.repeat(32)}`,
      },
    ],
  };
}

function view(item = post()): CollectionView {
  return {
    snapshot: {
      root,
      loadedAt: '2026-09-22T09:00:00+09:00',
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

function setup(initialView = view()) {
  const refresh = vi.fn().mockResolvedValue(initialView);
  const choose = vi.fn().mockResolvedValue(destination);
  const cancel = vi.fn();
  const launch = vi.fn<LaunchExport>(() => ({ result: Promise.resolve(), cancel }));
  const controller = new PostExportController(refresh, choose, launch);
  return { refresh, choose, cancel, launch, controller };
}

describe('post ZIP export process ownership', () => {
  it('refreshes source metadata and sends only identity and destination to the worker', async () => {
    const current = view();
    current.snapshot!.posts[0].caption = 'Updated source text, never copied into the IPC job.';
    const { refresh, choose, launch, controller } = setup(current);

    expect(await controller.export(root, postKey)).toEqual({
      status: 'saved',
      fileName: 'AbC_01.zip',
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
    expect(choose).toHaveBeenCalledExactlyOnceWith('AbC_01.zip');
    expect(launch).toHaveBeenCalledExactlyOnceWith({ root, postKey, destination });
    expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(choose.mock.invocationCallOrder[0]);
    expect(choose.mock.invocationCallOrder[0]).toBeLessThan(launch.mock.invocationCallOrder[0]);
    expect(controller.active).toBe(false);
  });

  it('permits an unconfirmed carousel total when all observed images and videos are saved', async () => {
    const item = post();
    expect(item.attachmentStatus).toBe('partial');
    expect(postExportIssue(item)).toBeNull();
    const { controller, launch } = setup(view(item));
    expect((await controller.export(root, postKey)).status).toBe('saved');
    expect(launch).toHaveBeenCalledOnce();
  });

  it.each(['not_downloaded', 'unavailable', 'review'] as const)(
    'rejects an attachment that becomes %s on refresh before opening the chooser',
    async (status) => {
      const item = post();
      item.attachments[1].status = status;
      const { controller, choose, launch } = setup(view(item));
      expect(await controller.export(root, postKey)).toMatchObject({
        status: 'error',
        problem: { code: 'export_media_missing' },
      });
      expect(choose).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it.each(['mediaId', 'localUrl'] as const)(
    'rejects saved attachments without a verified %s',
    async (field) => {
      const item = post();
      item.attachments[1][field] = null;
      const { controller, choose, launch } = setup(view(item));
      expect(await controller.export(root, postKey)).toMatchObject({
        status: 'error',
        problem: { code: 'export_media_missing' },
      });
      expect(choose).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('rejects an empty attachment set', async () => {
    const item = post();
    item.attachments = [];
    const { controller, choose, launch } = setup(view(item));
    expect(await controller.export(root, postKey)).toMatchObject({
      status: 'error',
      problem: { code: 'export_media_missing' },
    });
    expect(choose).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it('refuses stale metadata when refreshing the original detects a changed file', async () => {
    const current = view();
    current.error = { code: 'read_failed', message: 'The saved image changed.' };
    const { controller, choose, launch } = setup(current);
    expect(await controller.export(root, postKey)).toEqual({
      status: 'error',
      problem: current.error,
    });
    expect(choose).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  it.each(['missing-post', 'different-root', 'no-snapshot'])(
    'refuses an unavailable original: %s',
    async (reason) => {
      const current = view();
      if (reason === 'missing-post') current.snapshot!.posts = [];
      if (reason === 'different-root') current.snapshot!.root = '/another-collection';
      if (reason === 'no-snapshot') current.snapshot = null;
      const { controller, choose, launch } = setup(current);
      expect(await controller.export(root, postKey)).toMatchObject({
        status: 'error',
        problem: { code: 'export_post_missing' },
      });
      expect(choose).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it('treats native dialog cancellation as cancellation and launches no worker', async () => {
    const { controller, choose, launch } = setup();
    choose.mockResolvedValue(null);
    expect(await controller.export(root, postKey)).toEqual({ status: 'cancelled' });
    expect(controller.active).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });

  it('coalesces clicks throughout the chooser and worker and allows a later export', async () => {
    const choice = deferred<string | null>();
    const worker = deferred<void>();
    const { controller, refresh, choose, launch, cancel } = setup();
    choose.mockReturnValue(choice.promise);
    launch.mockReturnValue({ result: worker.promise, cancel });
    const first = controller.export(root, postKey);
    await Promise.resolve();
    expect(controller.active).toBe(true);
    expect(await controller.export('/other', 'other:Other')).toMatchObject({
      status: 'error',
      problem: { code: 'export_busy' },
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();

    choice.resolve(destination);
    await Promise.resolve();
    expect(launch).toHaveBeenCalledOnce();
    expect(await controller.export(root, postKey)).toMatchObject({
      status: 'error',
      problem: { code: 'export_busy' },
    });
    expect(choose).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
    worker.resolve();
    expect((await first).status).toBe('saved');
    expect(controller.active).toBe(false);
    expect((await controller.export(root, postKey)).status).toBe('saved');
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('surfaces a worker failure, releases ownership, and does not retry', async () => {
    const { controller, launch, cancel } = setup();
    launch.mockImplementationOnce(() => ({
      result: Promise.reject(new ViewError('media_changed', 'The image changed during export.')),
      cancel,
    }));
    expect(await controller.export(root, postKey)).toEqual({
      status: 'error',
      problem: { code: 'media_changed', message: 'The image changed during export.' },
    });
    expect(controller.active).toBe(false);
    expect(launch).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });

  it('sanitizes unexpected launch failures without exposing internal paths', async () => {
    const { controller, launch } = setup();
    launch.mockImplementationOnce(() => {
      throw new Error('spawn failed: /private/internal/path');
    });
    const result = await controller.export(root, postKey);
    expect(result).toMatchObject({ status: 'error', problem: { code: 'export_failed' } });
    expect(JSON.stringify(result)).not.toContain('/private/internal/path');
    expect(controller.active).toBe(false);
  });

  it('cancels a live worker and waits for its cleanup before shutdown settles', async () => {
    const worker = deferred<void>();
    const started = deferred<void>();
    const { controller, launch, cancel } = setup();
    launch.mockImplementationOnce(() => {
      started.resolve();
      return { result: worker.promise, cancel };
    });
    const result = controller.export(root, postKey);
    await started.promise;
    const settled = vi.fn();
    const shutdown = controller.shutdown().then(settled);
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    expect(settled).not.toHaveBeenCalled();
    worker.reject(new ViewError('cancelled', 'Export stopped.'));
    await shutdown;
    expect(await result).toEqual({ status: 'cancelled' });
    expect(settled).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
  });

  it('does not launch after shutdown while the native chooser was pending', async () => {
    const choice = deferred<string | null>();
    const { controller, choose, launch } = setup();
    choose.mockReturnValueOnce(choice.promise);
    const result = controller.export(root, postKey);
    await Promise.resolve();
    expect(choose).toHaveBeenCalledOnce();
    await controller.shutdown();
    choice.resolve(destination);
    expect(await result).toEqual({ status: 'cancelled' });
    expect(launch).not.toHaveBeenCalled();
    expect(controller.active).toBe(false);
  });

  it.each(['relative/AbC_01.zip', '/exports/AbC_01.txt', '/exports/AbC_01.zip.exe'])(
    'rejects invalid destinations before launch: %s',
    async (invalid) => {
      const { controller, choose, launch } = setup();
      choose.mockResolvedValueOnce(invalid);
      expect(await controller.export(root, postKey)).toMatchObject({
        status: 'error',
        problem: { code: 'export_destination' },
      });
      expect(launch).not.toHaveBeenCalled();
    },
  );
});

describe('post archive filename', () => {
  it('uses the post ID only, with no collection or export date', () => {
    expect(archiveFileName('AbC_01-xy')).toBe('AbC_01-xy.zip');
  });

  it.each([
    '',
    '../escape',
    'a/b',
    'a\\b',
    'a.zip',
    'a\0b',
    'a'.repeat(129),
    'CON',
    'prn',
    'Aux',
    'nul',
    'COM1',
    'lpt9',
  ])('refuses unsafe or Windows reserved post IDs: %s', (postId) => {
    expect(() => archiveFileName(postId)).toThrow(ViewError);
  });

  it('refuses an unsafe refreshed ID before opening the native chooser', async () => {
    const item = post();
    item.postId = '../escape';
    const { controller, choose, launch } = setup(view(item));
    expect(await controller.export(root, postKey)).toMatchObject({
      status: 'error',
      problem: { code: 'export_post_id' },
    });
    expect(choose).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('export worker response boundary', () => {
  it('accepts only the expected successful archive filename', () => {
    expect(parseExportResult('{"ok":true,"fileName":"AbC_01.zip"}', 'AbC_01.zip')).toBeUndefined();
  });

  it('propagates a bounded structured worker failure', () => {
    expect(() =>
      parseExportResult(
        '{"ok":false,"error":{"code":"media_changed","message":"The image changed."}}',
        'AbC_01.zip',
      ),
    ).toThrow(new ViewError('media_changed', 'The image changed.'));
  });

  it('never returns extra worker fields or private paths to the caller', () => {
    expect(
      parseExportResult(
        '{"ok":true,"fileName":"AbC_01.zip","destination":"/private/internal/path","path":"/private/internal/path"}',
        'AbC_01.zip',
      ),
    ).toBeUndefined();
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    '{"ok":true}',
    '{"ok":"true","fileName":"AbC_01.zip"}',
    '{"ok":true,"fileName":"another.zip"}',
    '{"ok":true,"fileName":"/exports/AbC_01.zip"}',
    '{"ok":true,"fileName":"../AbC_01.zip"}',
    '{"ok":true,"fileName":"C:\\\\exports\\\\AbC_01.zip"}',
    '{"ok":false,"error":{"code":"../private","message":"Invalid"}}',
    '{"ok":false,"error":{"code":"invalid","message":123}}',
    JSON.stringify({ ok: false, error: { code: 'invalid', message: 'a'.repeat(2001) } }),
  ])('rejects malformed, inconsistent, or path-bearing output %s', (raw) => {
    expect(() => parseExportResult(raw, 'AbC_01.zip')).toThrow(
      new ViewError(
        'export_response',
        'ZIP 저장 결과를 확인하지 못했습니다. 저장 폴더를 확인하세요.',
      ),
    );
  });
});
