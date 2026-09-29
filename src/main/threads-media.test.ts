import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile, type ChildProcess } from 'node:child_process';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { MediaRegistry, LocalFile } from './media';
import { prepareThreadsMedia } from './threads-media';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
const directories: string[] = [];
let video = { streams: [{ codec_type: 'video', codec_name: 'h264' }], format: { duration: '30' } };
beforeEach(() => {
  vi.clearAllMocks();
  video = { streams: [{ codec_type: 'video', codec_name: 'h264' }], format: { duration: '30' } };
  vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
    (args.at(-1) as (error: Error | null, stdout: string) => void)(null, JSON.stringify(video));
    return {} as ChildProcess;
  }) as typeof execFile);
});
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function setup(entries: { extension: string; size?: number; kind?: 'image' | 'video' }[]) {
  const directory = await mkdtemp(join(tmpdir(), 'threads-media-test-'));
  directories.push(directory);
  const files: LocalFile[] = entries.map((entry, index) => ({
    id: String(index + 1).padStart(32, '0'),
    relativePath: `media/selected-${index + 1}.${entry.extension}`,
    kind: entry.kind ?? 'image',
    size: entry.size ?? 8,
    sha256: 'a'.repeat(64),
  }));
  const copyForUpload = vi.fn(async (_root: string, id: string, destination: string) => {
    const file = files.find((file) => file.id === id)!;
    const handle = await open(destination, 'wx', 0o600);
    await handle.truncate(file.size);
    await handle.close();
    return file;
  });
  const registry = { copyForUpload } as unknown as MediaRegistry;
  const convert = vi.fn(() => Buffer.from('synthetic-png'));
  return {
    directory,
    files,
    registry,
    copyForUpload,
    convert,
    run: (ids = files.map((file) => file.id)) =>
      prepareThreadsMedia(registry, '/library', ids, directory, convert),
  };
}
describe('Threads media preparation', () => {
  it('rejects empty, duplicate, and oversized selections before reading media', async () => {
    const f = await setup([{ extension: 'jpg' }]);
    for (const ids of [
      [],
      [f.files[0].id, f.files[0].id],
      Array.from({ length: 21 }, (_, i) => String(i)),
    ])
      await expect(f.run(ids)).rejects.toMatchObject({ code: 'threads_media_limit' });
    expect(f.copyForUpload).not.toHaveBeenCalled();
  });
  it('preserves selected image ordering and converts only WebP', async () => {
    const f = await setup([{ extension: 'png' }, { extension: 'webp' }, { extension: 'jpg' }]);
    const prepared = await f.run([f.files[2].id, f.files[1].id, f.files[0].id]);
    expect(prepared.map((file) => basename(file.path))).toEqual(['1.jpg', '2.png', '3.png']);
    expect(prepared.map((file) => file.mediaId)).toEqual([
      f.files[2].id,
      f.files[1].id,
      f.files[0].id,
    ]);
    expect(prepared.map((file) => file.contentType)).toEqual([
      'image/jpeg',
      'image/png',
      'image/png',
    ]);
    expect(await readFile(prepared[1].path, 'utf8')).toBe('synthetic-png');
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(execFile).not.toHaveBeenCalled();
  });
  it.each([
    { extension: 'gif' },
    { extension: 'png', size: 8 * 1024 * 1024 + 1 },
    { extension: 'webp', size: 32 * 1024 * 1024 + 1 },
  ])('rejects unsupported or oversized images: %j', async (entry) => {
    const f = await setup([entry]);
    await expect(f.run()).rejects.toMatchObject({ code: 'threads_image' });
    expect(f.convert).not.toHaveBeenCalled();
  });
  it.each([0, 8 * 1024 * 1024 + 1])(
    'rejects unusable conversion output of %i bytes',
    async (size) => {
      const f = await setup([{ extension: 'webp' }]);
      f.convert.mockReturnValue(Buffer.alloc(size));
      await expect(f.run()).rejects.toMatchObject({ code: 'threads_image' });
    },
  );
  it('propagates local integrity failures before conversion', async () => {
    const f = await setup([{ extension: 'webp' }]);
    f.copyForUpload.mockRejectedValueOnce(new Error('changed local bytes'));
    await expect(f.run()).rejects.toThrow('changed local bytes');
    expect(f.convert).not.toHaveBeenCalled();
    expect(execFile).not.toHaveBeenCalled();
  });
  it('validates local video metadata with external references and network protocols disabled', async () => {
    const f = await setup([{ extension: 'mp4', kind: 'video' }]);
    const prepared = await f.run();
    expect(prepared[0]).toMatchObject({ contentType: 'video/mp4', kind: 'video' });
    const args = vi.mocked(execFile).mock.calls[0][1] as string[];
    expect(
      args.slice(args.indexOf('-protocol_whitelist'), args.indexOf('-protocol_whitelist') + 2),
    ).toEqual(['-protocol_whitelist', 'file']);
    expect(args.slice(args.indexOf('-enable_drefs'), args.indexOf('-enable_drefs') + 2)).toEqual([
      '-enable_drefs',
      '0',
    ]);
    expect(
      args.slice(args.indexOf('-use_absolute_path'), args.indexOf('-use_absolute_path') + 2),
    ).toEqual(['-use_absolute_path', '0']);
    expect(f.convert).not.toHaveBeenCalled();
  });
  it.each(['301', '0', 'unknown'])('rejects invalid video duration %s', async (duration) => {
    const f = await setup([{ extension: 'mov', kind: 'video' }]);
    video.format.duration = duration;
    await expect(f.run()).rejects.toMatchObject({ code: 'threads_video' });
  });
  it('rejects unsupported audio and propagates ffprobe unavailability as a safe actionable error', async () => {
    const f = await setup([{ extension: 'mp4', kind: 'video' }]);
    video.streams.push({ codec_type: 'audio', codec_name: 'mp3' });
    await expect(f.run()).rejects.toMatchObject({ code: 'threads_video' });
    const second = await setup([{ extension: 'mp4', kind: 'video' }]);
    vi.mocked(execFile).mockImplementationOnce(((...args: unknown[]) => {
      (args.at(-1) as (error: Error, stdout: string) => void)(new Error('private path'), '');
      return {} as ChildProcess;
    }) as typeof execFile);
    await expect(second.run()).rejects.toMatchObject({ code: 'threads_video' });
  });
});
