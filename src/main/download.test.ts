import { describe, it, expect, vi } from 'vitest';
import { DownloadController, parseResult, type Launch } from './download';
import { ViewError } from './collection';

const target = { account: 'example', postId: 'AbC_01', ordinal: 1, kind: 'image' as const };
const plan = {
  ...target,
  source: 'results/2026/09/threads-2026-09-21.xlsx',
  sourceHash: 'a'.repeat(64),
  urlHash: 'b'.repeat(64),
  runId: 'RunA',
};
const ready = () => ({
  target,
  plan,
  nextAllowedAt: null,
  problem: null,
  recoverable: false,
});
type Result = Awaited<ReturnType<Launch>['result']>;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('download process ownership', () => {
  it('prepares without writes, runs only once, keeps plans private, and refreshes after completion', async () => {
    const pending = deferred<Result>();
    const cancel = vi.fn();
    let progress!: Parameters<Launch>[2];
    const launch = vi.fn<Launch>((_root, input, cb) => {
      progress = cb;
      return {
        cancel,
        result: input.command === 'preview' ? Promise.resolve(ready()) : pending.promise,
      };
    });
    const refresh = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, refresh);
    controller.prepare('/root', 'example');
    controller.prepare('/other', 'other');
    await controller.settled();
    expect(launch).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(controller.view.phase).toBe('ready');
    expect(JSON.stringify(controller.view)).not.toContain('sourceHash');
    controller.start('/other');
    expect(controller.active).toBe(false);
    controller.start('/root');
    controller.start('/root');
    controller.reset();
    await Promise.resolve();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(launch.mock.calls[1][1]).toEqual({ command: 'download', plan });
    progress({ phase: 'validating', received: 200, total: 200 });
    expect(controller.view.received).toBe(200);
    expect(refresh).not.toHaveBeenCalled();
    pending.resolve({
      ...ready(),
      nextAllowedAt: 12345,
    });
    await controller.settled();
    expect(controller.view.phase).toBe('complete');
    expect(refresh).toHaveBeenCalledTimes(1);
    controller.start('/root');
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('cancels a late preview and never makes it downloadable', async () => {
    const pending = deferred<Result>();
    const cancel = vi.fn();
    const controller = new DownloadController(() => ({ result: pending.promise, cancel }), vi.fn());
    controller.prepare('/root', 'example');
    controller.stop();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    pending.resolve(ready());
    await controller.settled();
    expect(controller.view.problem?.code).toBe('cancelled');
    expect(controller.view.phase).toBe('error');
  });
  it('waits for cancellation and refresh on shutdown, then does not auto retry', async () => {
    const pending = deferred<Result>();
    const cancel = vi.fn(() => pending.reject(new ViewError('cancelled', 'Stopped')));
    const refresh = vi.fn().mockResolvedValue(undefined);
    const launch = vi.fn<Launch>((_root, input) => ({
      cancel,
      result: input.command === 'preview' ? Promise.resolve(ready()) : pending.promise,
    }));
    const controller = new DownloadController(launch, refresh);
    controller.prepare('/root', 'example');
    await controller.settled();
    controller.start('/root');
    await controller.shutdown();
    expect(controller.active).toBe(false);
    expect(controller.view.recoverable).toBe(true);
    expect(controller.view.problem?.code).toBe('cancelled');
    expect(cancel).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
    controller.start('/root');
    expect(launch).toHaveBeenCalledTimes(2);
  });
  it('survives synchronous launch failure and permits a later preparation', async () => {
    const launch = vi
      .fn<Launch>()
      .mockImplementationOnce(() => {
        throw new Error('spawn');
      })
      .mockReturnValue({ result: Promise.resolve(ready()), cancel: vi.fn() });
    const controller = new DownloadController(launch, vi.fn());
    controller.prepare('/root', 'example');
    await controller.settled();
    expect(controller.active).toBe(false);
    expect(controller.view.phase).toBe('error');
    controller.prepare('/root', 'example');
    await controller.settled();
    expect(controller.view.phase).toBe('ready');
  });
  it('keeps stored waits blocked and uses a distinct recovery command', async () => {
    const blocked = { ...ready(), problem: { code: 'waiting', message: 'Wait' } };
    const launch = vi
      .fn<Launch>()
      .mockReturnValue({ result: Promise.resolve(blocked), cancel: vi.fn() });
    const controller = new DownloadController(launch, vi.fn().mockResolvedValue(undefined));
    controller.prepare('/root', 'example');
    await controller.settled();
    controller.start('/root');
    expect(controller.view.phase).toBe('blocked');
    expect(launch).toHaveBeenCalledOnce();
    controller.recover('/root');
    await controller.settled();
    expect(launch.mock.calls[1][1]).toEqual({ command: 'recover' });
    expect(controller.view.phase).toBe('blocked');
  });
});

describe('worker response boundary', () => {
  it('strips unexpected fields so private URLs cannot cross through result objects', () => {
    const result = parseResult({
      ...ready(),
      target: { ...target, url: 'https://private.test' },
      secret: 'secret',
    });
    expect(JSON.stringify(result)).not.toContain('private.test');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it.each([
    {},
    { ...ready(), nextAllowedAt: -1 },
    { ...ready(), plan: { ...plan, source: '../outside.xlsx' } },
    { ...ready(), target: { ...target, ordinal: 2 } },
    { ...ready(), target: { ...target, account: 'https://signed-url' } },
  ])('rejects invalid or inconsistent worker results', (input) => {
    expect(() => parseResult(input)).toThrow(ViewError);
  });
});

const batch = () => ({
  totalPosts: 3,
  completedPosts: 1,
  totalFiles: 5,
  completedFiles: 2,
  totalRounds: 2,
  currentRound: 1,
  deferredPosts: 1,
});
const batchResult = () => ({
  target: null,
  plan: null,
  nextAllowedAt: null,
  problem: null,
  recoverable: false,
  batch: batch(),
});

describe('whole collection download ownership', () => {
  it('does nothing before a click and starts one batch directly while guarding every entry point', async () => {
    const pending = deferred<Result>();
    const launch = vi.fn<Launch>(() => ({ result: pending.promise, cancel: vi.fn() }));
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    expect(controller.active).toBe(false);
    expect(controller.view.phase).toBe('idle');
    expect(launch).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();

    expect(controller.startAll('/root')).toBe(controller.view);
    expect(controller.active).toBe(true);
    controller.startAll('/other');
    controller.prepare('/other', 'other');
    controller.start('/other');
    controller.recover('/other');
    controller.reset();
    await Promise.resolve();
    expect(launch).toHaveBeenCalledExactlyOnceWith(
      '/root',
      { command: 'batch' },
      expect.any(Function),
    );
    expect(afterWrite).not.toHaveBeenCalled();
    pending.resolve(batchResult());
    await controller.settled();
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it('shows the current target, persisted wait, and aggregate counts without losing them on byte progress', async () => {
    const pending = deferred<Result>();
    let progress!: Parameters<Launch>[2];
    const launch = vi.fn<Launch>((_root, _input, cb) => {
      progress = cb;
      return { result: pending.promise, cancel: vi.fn() };
    });
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await Promise.resolve();
    progress({
      phase: 'waiting',
      received: 0,
      total: null,
      target,
      nextAllowedAt: 12345,
      batch: batch(),
    });
    expect(controller.view).toMatchObject({
      phase: 'waiting',
      target,
      nextAllowedAt: 12345,
      batch: batch(),
    });
    expect(controller.active).toBe(true);
    expect(afterWrite).not.toHaveBeenCalled();
    progress({
      phase: 'downloading',
      received: 500,
      total: 1000,
      nextAllowedAt: null,
    });
    expect(controller.view).toMatchObject({
      phase: 'downloading',
      received: 500,
      total: 1000,
      target,
      nextAllowedAt: null,
      batch: batch(),
    });
    const complete = { ...batch(), completedPosts: 3, completedFiles: 5, currentRound: 2 };
    pending.resolve({ ...batchResult(), batch: complete, nextAllowedAt: 12500 });
    await controller.settled();
    expect(controller.view).toMatchObject({
      phase: 'complete',
      batch: complete,
      nextAllowedAt: 12500,
    });
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
  });

  it('keeps the operation active until the saved collection refresh finishes', async () => {
    const refreshed = deferred<void>();
    const refreshStarted = deferred<void>();
    const launch = vi.fn<Launch>(() => ({
      result: Promise.resolve(batchResult()),
      cancel: vi.fn(),
    }));
    const afterWrite = vi.fn(() => {
      refreshStarted.resolve();
      return refreshed.promise;
    });
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await refreshStarted.promise;
    expect(controller.active).toBe(true);
    expect(controller.view.phase).toBe('checking');
    controller.startAll('/root');
    expect(launch).toHaveBeenCalledOnce();
    refreshed.resolve();
    await controller.settled();
    expect(controller.active).toBe(false);
    expect(controller.view.phase).toBe('complete');
  });

  it.each(['stop', 'shutdown'] as const)(
    'finishes normally when %s arrives after the worker exits but while the saved library is refreshing',
    async (action) => {
      const refreshed = deferred<void>();
      const refreshStarted = deferred<void>();
      const cancel = vi.fn();
      const launch = vi.fn<Launch>(() => ({
        result: Promise.resolve(batchResult()),
        cancel,
      }));
      const afterWrite = vi.fn(() => {
        refreshStarted.resolve();
        return refreshed.promise;
      });
      const controller = new DownloadController(launch, afterWrite);
      controller.startAll('/root');
      await refreshStarted.promise;
      expect(controller.active).toBe(true);
      expect(controller.view.phase).toBe('checking');
      const finished = vi.fn();
      const shutdown = action === 'shutdown' ? controller.shutdown().then(finished) : undefined;
      if (action === 'stop') controller.stop();
      await Promise.resolve();
      expect(controller.view.phase).toBe('stopping');
      expect(cancel).not.toHaveBeenCalled();
      expect(finished).not.toHaveBeenCalled();
      controller.startAll('/other');
      expect(launch).toHaveBeenCalledOnce();
      refreshed.resolve();
      await controller.settled();
      await shutdown;
      expect(controller.active).toBe(false);
      expect(controller.view.phase).toBe('complete');
      expect(controller.view.problem).toBeNull();
      expect(afterWrite).toHaveBeenCalledOnce();
      if (action === 'shutdown') expect(finished).toHaveBeenCalledOnce();
    },
  );

  it('preserves the worker error when stop arrives during its final library refresh', async () => {
    const refreshed = deferred<void>();
    const refreshStarted = deferred<void>();
    const cancel = vi.fn();
    const controller = new DownloadController(
      () => ({
        result: Promise.reject(new ViewError('http_error', 'First download failure.')),
        cancel,
      }),
      () => {
        refreshStarted.resolve();
        return refreshed.promise;
      },
    );
    controller.startAll('/root');
    await refreshStarted.promise;
    expect(controller.active).toBe(true);
    expect(controller.view.phase).toBe('checking');
    controller.stop();
    expect(cancel).not.toHaveBeenCalled();
    refreshed.resolve();
    await controller.settled();
    expect(controller.active).toBe(false);
    expect(controller.view).toMatchObject({
      phase: 'error',
      problem: { code: 'http_error', message: 'First download failure.' },
      recoverable: true,
    });
  });

  it.each(['complete', 'error'] as const)(
    'releases ownership and retains the %s outcome if afterWrite throws synchronously',
    async (phase) => {
      const launch = vi.fn<Launch>(() => ({
        result:
          phase === 'complete'
            ? Promise.resolve(batchResult())
            : Promise.reject(new ViewError('http_error', 'First download failure.')),
        cancel: vi.fn(),
      }));
      const afterWrite = vi.fn(() => {
        throw new Error('Synchronous collection refresh failure');
      });
      const controller = new DownloadController(launch, afterWrite);
      controller.startAll('/root');
      await expect(controller.settled()).resolves.toBeUndefined();
      expect(controller.active).toBe(false);
      expect(controller.view.phase).toBe(phase);
      expect(controller.view.problem?.code ?? null).toBe(phase === 'error' ? 'http_error' : null);
      expect(afterWrite).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledOnce();
      controller.reset();
      expect(controller.view.phase).toBe('idle');
    },
  );

  it('keeps a batch hold and partial counts visible, refreshes once, and never starts another worker', async () => {
    const problem = { code: 'source_changed', message: 'The source changed during this batch.' };
    const launch = vi.fn<Launch>(() => ({
      result: Promise.resolve({ ...batchResult(), problem, nextAllowedAt: 12345 }),
      cancel: vi.fn(),
    }));
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await controller.settled();
    expect(controller.view).toMatchObject({
      phase: 'blocked',
      problem,
      batch: batch(),
      nextAllowedAt: 12345,
    });
    expect(controller.active).toBe(false);
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('preserves completed counts after the first worker failure and refreshes saved posts', async () => {
    const pending = deferred<Result>();
    let progress!: Parameters<Launch>[2];
    const launch = vi.fn<Launch>((_root, _input, cb) => {
      progress = cb;
      return { result: pending.promise, cancel: vi.fn() };
    });
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await Promise.resolve();
    progress({ phase: 'validating', received: 1000, total: 1000, target, batch: batch() });
    pending.reject(new ViewError('http_error', 'Download stopped.'));
    await controller.settled();
    expect(controller.view).toMatchObject({
      phase: 'error',
      problem: { code: 'http_error', message: 'Download stopped.' },
      recoverable: true,
      batch: batch(),
      target,
    });
    expect(controller.active).toBe(false);
    expect(launch).toHaveBeenCalledOnce();
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it('cancels a batch during a wait and ignores late progress until the worker exits', async () => {
    const pending = deferred<Result>();
    const cancel = vi.fn();
    let progress!: Parameters<Launch>[2];
    const launch = vi.fn<Launch>((_root, _input, cb) => {
      progress = cb;
      return { result: pending.promise, cancel };
    });
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await Promise.resolve();
    progress({
      phase: 'waiting',
      received: 0,
      total: null,
      nextAllowedAt: 12345,
      batch: batch(),
    });
    expect(controller.stop().phase).toBe('stopping');
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.active).toBe(true);
    progress({ phase: 'downloading', received: 100, total: 1000 });
    expect(controller.view.phase).toBe('stopping');
    expect(controller.view.received).toBe(0);
    expect(afterWrite).not.toHaveBeenCalled();
    pending.reject(new ViewError('cancelled', 'Stopped'));
    await controller.settled();
    expect(controller.view).toMatchObject({
      phase: 'error',
      problem: { code: 'cancelled' },
      batch: batch(),
    });
    expect(afterWrite).toHaveBeenCalledOnce();
  });

  it('waits for both cancelled worker cleanup and the collection refresh on shutdown', async () => {
    const pending = deferred<Result>();
    const refreshed = deferred<void>();
    const refreshStarted = deferred<void>();
    const cancel = vi.fn();
    const afterWrite = vi.fn(() => {
      refreshStarted.resolve();
      return refreshed.promise;
    });
    const launch = vi.fn<Launch>(() => ({ result: pending.promise, cancel }));
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await Promise.resolve();
    const finished = vi.fn();
    const shutdown = controller.shutdown().then(finished);
    expect(cancel).toHaveBeenCalledOnce();
    expect(finished).not.toHaveBeenCalled();
    expect(afterWrite).not.toHaveBeenCalled();
    pending.reject(new ViewError('cancelled', 'Stopped'));
    await refreshStarted.promise;
    expect(controller.active).toBe(true);
    expect(finished).not.toHaveBeenCalled();
    refreshed.resolve();
    await shutdown;
    expect(finished).toHaveBeenCalledOnce();
    expect(controller.active).toBe(false);
    expect(launch).toHaveBeenCalledOnce();
  });

  it('honors a stop issued before the batch process has started', async () => {
    const pending = deferred<Result>();
    const cancel = vi.fn(() => pending.reject(new ViewError('cancelled', 'Stopped')));
    const launch = vi.fn<Launch>(() => ({ result: pending.promise, cancel }));
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    controller.stop();
    await controller.settled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(controller.view.problem?.code).toBe('cancelled');
    expect(controller.active).toBe(false);
    expect(afterWrite).toHaveBeenCalledOnce();
  });
});

describe('download state across collection refreshes', () => {
  it.each(['complete', 'blocked', 'error'] as const)(
    'preserves the %s outcome, counters, and revision when reconnecting the same root',
    async (phase) => {
      const pending = deferred<Result>();
      let progress!: Parameters<Launch>[2];
      const launch = vi.fn<Launch>((_root, _input, cb) => {
        progress = cb;
        return { result: pending.promise, cancel: vi.fn() };
      });
      const afterWrite = vi.fn().mockResolvedValue(undefined);
      const controller = new DownloadController(launch, afterWrite);
      controller.startAll('/root');
      await Promise.resolve();
      progress({
        phase: 'waiting',
        target,
        received: 0,
        total: null,
        nextAllowedAt: 12345,
        batch: batch(),
      });
      if (phase === 'error') pending.reject(new ViewError('http_error', 'Download stopped.'));
      else
        pending.resolve({
          ...batchResult(),
          nextAllowedAt: 12345,
          problem:
            phase === 'blocked' ? { code: 'source_changed', message: 'Source changed.' } : null,
        });
      await controller.settled();
      expect(controller.view.phase).toBe(phase);
      const before = controller.view;
      const snapshot = structuredClone(before);

      controller.resetForRoot('/root');
      controller.resetForRoot('/root');
      expect(controller.view).toBe(before);
      expect(controller.view).toEqual(snapshot);
      expect(controller.view.batch).toEqual(batch());
      expect(controller.view.nextAllowedAt).toBe(12345);
      expect(afterWrite).toHaveBeenCalledOnce();
      expect(launch).toHaveBeenCalledOnce();
    },
  );

  it('clears the previous outcome only when the connected root changes and remembers the new root', async () => {
    const launch = vi.fn<Launch>(() => ({
      result: Promise.resolve({
        ...batchResult(),
        problem: { code: 'source_changed', message: 'Source changed.' },
      }),
      cancel: vi.fn(),
    }));
    const afterWrite = vi.fn().mockResolvedValue(undefined);
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    await controller.settled();
    const revision = controller.view.revision;

    controller.resetForRoot('/new-root');
    expect(controller.view).toEqual({
      phase: 'idle',
      target: null,
      nextAllowedAt: null,
      problem: null,
      recoverable: false,
      received: 0,
      total: null,
      revision: revision + 1,
    });
    const cleared = controller.view;
    controller.resetForRoot('/new-root');
    expect(controller.view).toBe(cleared);
    expect(controller.active).toBe(false);
    expect(afterWrite).toHaveBeenCalledOnce();
    expect(launch).toHaveBeenCalledOnce();
  });

  it('protects the active worker root and progress through its final collection refresh', async () => {
    const pending = deferred<Result>();
    const refreshed = deferred<void>();
    const refreshStarted = deferred<void>();
    const cancel = vi.fn();
    let progress!: Parameters<Launch>[2];
    const launch = vi.fn<Launch>((_root, _input, cb) => {
      progress = cb;
      return { result: pending.promise, cancel };
    });
    const afterWrite = vi.fn(() => {
      refreshStarted.resolve();
      return refreshed.promise;
    });
    const controller = new DownloadController(launch, afterWrite);
    controller.startAll('/root');
    controller.resetForRoot('/other');
    await Promise.resolve();
    expect(launch.mock.calls[0][0]).toBe('/root');
    progress({ phase: 'waiting', received: 0, total: null, nextAllowedAt: 12345, batch: batch() });
    const waiting = controller.view;
    controller.resetForRoot('/root');
    controller.resetForRoot('/other');
    controller.reset();
    expect(controller.view).toBe(waiting);
    expect(controller.active).toBe(true);
    expect(cancel).not.toHaveBeenCalled();

    pending.resolve(batchResult());
    await refreshStarted.promise;
    controller.resetForRoot('/other');
    expect(controller.view).toBe(waiting);
    expect(controller.active).toBe(true);
    refreshed.resolve();
    await controller.settled();
    const complete = controller.view;
    expect(complete.phase).toBe('complete');
    controller.resetForRoot('/root');
    expect(controller.view).toBe(complete);
    expect(launch).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('batch worker response boundary', () => {
  it('accepts an absent batch for the existing single-file worker and a zero-work batch', () => {
    expect(parseResult(ready()).target).toEqual(target);
    const emptyBatch = {
      totalPosts: 0,
      completedPosts: 0,
      totalFiles: 0,
      completedFiles: 0,
      totalRounds: 0,
      currentRound: 0,
      deferredPosts: 2,
    };
    expect(parseResult({ ...batchResult(), batch: emptyBatch }).batch).toEqual(emptyBatch);
  });

  it('returns only public batch counters and strips private metadata from every nested object', () => {
    const result = parseResult({
      ...batchResult(),
      target: { ...target, url: 'https://private.test/signed' },
      batch: { ...batch(), url: 'https://private.test/signed', plan: { sourceHash: 'secret' } },
      problem: { code: 'held', message: 'Wait', source: '/private/internal/path' },
      privatePath: '/private/internal/path',
    });
    expect(result.batch).toEqual(batch());
    expect(result.target).toEqual(target);
    expect(result.problem).toEqual({ code: 'held', message: 'Wait' });
    expect(JSON.stringify(result)).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it.each([
    { ...batch(), totalPosts: -1 },
    { ...batch(), completedPosts: 0.5 },
    { ...batch(), totalFiles: Number.MAX_SAFE_INTEGER + 1 },
    { ...batch(), completedFiles: '2' },
    { ...batch(), totalRounds: Infinity },
    { ...batch(), currentRound: NaN },
    { ...batch(), deferredPosts: -1 },
    { ...batch(), completedPosts: 4 },
    { ...batch(), completedFiles: 6 },
    { ...batch(), currentRound: 3 },
    { totalPosts: 3 },
    [],
    'batch',
  ])('rejects invalid counter ranges or completed totals: %j', (invalidBatch) => {
    expect(() => parseResult({ ...batchResult(), batch: invalidBatch })).toThrow(ViewError);
  });
});
