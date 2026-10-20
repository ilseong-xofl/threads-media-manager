import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { launchWebpToPng } from './webp-png';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./python', () => ({
  pythonCommand: () => ({ command: 'mock-python-never-executed', prefix: ['-X', 'utf8'] }),
}));

function launch() {
  const child = { stdin: { on: vi.fn(), end: vi.fn() } };
  vi.mocked(execFile).mockReturnValue(child as unknown as ChildProcess);
  const result = launchWebpToPng('/synthetic-app')('/outbox/job/2.webp', '/outbox/job/2.png');
  const call = vi.mocked(execFile).mock.calls.at(-1)!;
  const finish = call[3];
  if (typeof finish !== 'function') throw new Error('Missing execFile callback');
  return { child, result, call, finish };
}

describe('WebP upload conversion without starting a real process', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs the isolated bundled worker with only the two prepared paths', async () => {
    const { child, result, call, finish } = launch();
    expect(call[0]).toBe('mock-python-never-executed');
    expect(call[1]).toEqual([
      '-X',
      'utf8',
      '-I',
      '-B',
      join('/synthetic-app', 'local-runtime', 'convert_upload_image.py'),
    ]);
    expect(call[2]).toMatchObject({ timeout: 120_000, windowsHide: true });
    expect(JSON.parse(child.stdin.end.mock.calls[0][0])).toEqual({
      source: '/outbox/job/2.webp',
      destination: '/outbox/job/2.png',
    });
    finish(null, '{"ok":true}\n', '');
    await expect(result).resolves.toBeUndefined();
  });

  it('surfaces the worker reason instead of a generic send failure', async () => {
    const { result, finish } = launch();
    finish(
      new Error('exit 1'),
      '{"ok":false,"error":{"code":"convert_invalid_image","message":"WebP 이미지를 읽을 수 없습니다."}}',
      '',
    );
    await expect(result).rejects.toMatchObject({
      code: 'convert_invalid_image',
      message: 'WebP 이미지를 읽을 수 없습니다.',
    });
  });

  it.each([
    ['a missing runtime', new Error('spawn ENOENT'), ''],
    ['unreadable output', null, 'not json'],
    [
      'an unsafe error code',
      new Error('exit 1'),
      '{"ok":false,"error":{"code":"Bad","message":"x"}}',
    ],
    ['success after an abnormal exit', new Error('killed'), '{"ok":true}'],
  ])('reports %s as an actionable image error', async (_case, error, stdout) => {
    const { result, finish } = launch();
    finish(error, stdout, '');
    await expect(result).rejects.toMatchObject({
      code: 'threads_image',
      message: 'WebP 이미지를 PNG로 변환하지 못했습니다. 이미지를 JPG·PNG로 바꿔 다시 선택하세요.',
    });
  });
});
