import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launchWorker } from './download';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('./python', () => ({
  pythonCommand: () => ({ command: 'mock-python-never-executed', prefix: [] }),
}));

const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const waiting = () => ({
  type: 'progress',
  phase: 'waiting',
  received: 0,
  total: null,
  nextAllowedAt: 2_000_000_000,
});
const finalResult = () => ({
  type: 'result',
  ok: true,
  result: {
    target: null,
    nextAllowedAt: null,
    problem: null,
    recoverable: false,
  },
});

function setup(command = 'batch') {
  const child = Object.assign(new EventEmitter(), {
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn<(input: string) => boolean>(() => true),
    }),
    stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ChildProcess);
  const progress = vi.fn();
  const operation = launchWorker('/synthetic-app')('/synthetic-collection', { command }, progress);
  const cancellations = () =>
    child.stdin.write.mock.calls.filter(([input]) => input === '{"cancel":true}\n').length;
  return { child, progress, operation, cancellations };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-22T00:00:00Z'));
  vi.clearAllMocks();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('batch worker stream lifecycle without a real process', () => {
  it('gives resumed batches the same heartbeat watchdog as first runs', async () => {
    const { child, operation, cancellations } = setup('resume');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cancellations()).toBe(0);
    child.stdout.emit('data', line(waiting()));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(cancellations()).toBe(0);
    child.stdout.emit('data', line(finalResult()));
    child.emit('close', 0);
    await expect(operation.result).resolves.toMatchObject({ problem: null });
  });

  it('keeps the first watchdog timeout when late progress and process errors arrive', async () => {
    const { child, progress, operation, cancellations } = setup();
    const failure = operation.result.catch((error) => error);
    await vi.advanceTimersByTimeAsync(660_000);
    expect(cancellations()).toBe(1);
    child.stdout.emit('data', line(waiting()));
    child.emit('error', new Error('Late child process error'));
    child.stdout.emit('data', line(finalResult()));
    expect(progress).not.toHaveBeenCalled();
    expect(cancellations()).toBe(1);
    child.emit('close', 1);
    expect(await failure).toMatchObject({ code: 'worker_timeout' });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('discards all later output after an oversized line and cancels only once', async () => {
    const { child, progress, operation, cancellations } = setup();
    const failure = operation.result.catch((error) => error);
    child.stdout.emit('data', line(waiting()));
    expect(progress).toHaveBeenCalledOnce();
    child.stdout.emit('data', 'x'.repeat(64 * 1024 + 1));
    expect(cancellations()).toBe(1);
    for (let index = 0; index < 4; index++) {
      child.stdout.emit('data', 'x'.repeat(128 * 1024));
      child.stdout.emit('data', line(waiting()));
    }
    expect(progress).toHaveBeenCalledOnce();
    expect(cancellations()).toBe(1);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    child.emit('close', 1);
    expect(await failure).toMatchObject({
      code: 'worker_response',
      message: '다운로드 상태 응답이 허용 크기를 초과했습니다.',
    });
  });

  it('resets the 660-second watchdog on validated waiting heartbeats across a longer batch', async () => {
    const { child, progress, operation, cancellations } = setup();
    for (let index = 0; index < 3; index++) {
      await vi.advanceTimersByTimeAsync(600_000);
      child.stdout.emit('data', line(waiting()));
    }
    expect(progress).toHaveBeenCalledTimes(3);
    expect(cancellations()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    child.stdout.emit('data', line(finalResult()));
    child.emit('close', 0);
    await expect(operation.result).resolves.toMatchObject({ problem: null });
    await vi.advanceTimersByTimeAsync(700_000);
    expect(cancellations()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('keeps a structured worker error when the same chunk contains late progress', async () => {
    const { child, progress, operation, cancellations } = setup();
    const failure = operation.result.catch((error) => error);
    child.stdout.emit(
      'data',
      line({ type: 'result', ok: false, error: { code: 'http_error', message: 'First error.' } }) +
        line(waiting()),
    );
    child.stdout.emit('data', line(waiting()));
    expect(progress).not.toHaveBeenCalled();
    expect(cancellations()).toBe(1);
    child.emit('close', 1);
    expect(await failure).toMatchObject({ code: 'http_error', message: 'First error.' });
  });

  it('permits more than two megabytes over a long batch while bounding each output minute', async () => {
    const { child, operation, cancellations } = setup();
    const chunk = line(waiting()).repeat(400);
    expect(Buffer.byteLength(chunk)).toBeLessThan(64 * 1024);
    const minutes = Math.ceil((2 * 1024 * 1024) / Buffer.byteLength(chunk)) + 1;
    for (let index = 0; index < minutes; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      child.stdout.emit('data', chunk);
    }
    expect(Buffer.byteLength(chunk) * minutes).toBeGreaterThan(2 * 1024 * 1024);
    expect(cancellations()).toBe(0);
    child.stdout.emit('data', line(finalResult()));
    child.emit('close', 0);
    await expect(operation.result).resolves.toMatchObject({ problem: null });
  });
});
