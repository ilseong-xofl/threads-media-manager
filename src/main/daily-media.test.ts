import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DailyMediaLibrary, threadsVideo, type DailyMediaOptions } from './daily-media';

vi.mock('electron', () => ({ nativeImage: {} }));

const scope = { service: 'https://service.test', ownerId: 'owner-1' };
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const probe = (video: Record<string, unknown> = {}, duration = '10') => ({
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1080,
      height: 1920,
      avg_frame_rate: '30000/1001',
      ...video,
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
  format: { duration },
});

let base: string;
let work: string;
let sources: string;
let root: string;
let folder: string | null;
let picked: string[] | null;
let library: DailyMediaLibrary;
let overrides: Partial<DailyMediaOptions>;

const make = () =>
  new DailyMediaLibrary({
    workFolder: () => folder,
    pickFiles: async () => picked,
    webpToPng: async (source, target) =>
      writeFile(target, `img:${(await readFile(source, 'utf8')).slice('webp:'.length)}`),
    // Synthetic files: `img:<w>x<h>` decodes, a video holds its own ffprobe JSON.
    imageSize: async (path) => {
      const match = /^img:(\d+)x(\d+)/.exec(await readFile(path, 'utf8'));
      return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
    },
    probeVideo: async (path) => JSON.parse(await readFile(path, 'utf8')),
    ...overrides,
  });
const source = async (name: string, content: string | Buffer) => {
  const path = join(sources, name);
  await writeFile(path, content);
  return path;
};
const add = (paths: string[], extra: Record<string, unknown> = {}) =>
  library.add(scope, { room: 20, paths, ...extra });
const serve = (id: string) => library.respond(new Request(`threads-daily://file/${id}`));

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'tmm-daily-media-')));
  work = join(base, 'work');
  sources = join(base, 'sources');
  await mkdir(work);
  await mkdir(sources);
  root = join(work, 'daily-media', DailyMediaLibrary.partition(scope));
  folder = work;
  picked = null;
  overrides = {};
  library = make();
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('adding attachments', () => {
  it('copies into a pending selection with the stored hash and serves the copy', async () => {
    expect(DailyMediaLibrary.partition(scope)).toBe(
      sha('https://service.test\nowner-1').slice(0, 32),
    );
    const result = await add([await source('cat.JPG', 'img:640x480')]);
    expect(result).toMatchObject({ status: 'ok', problem: null });
    const [media] = result.media;
    expect(media).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{32}$/),
      kind: 'image',
      name: 'cat.JPG',
      url: `threads-daily://file/${media.id}`,
    });
    const stored = library.staged(scope, result.selectionId!)!.get(media.id)!;
    expect(stored).toMatchObject({
      relativePath: `media/files/${result.selectionId}/${media.id}.jpg`,
      size: 11,
      sha256: sha('img:640x480'),
    });
    await stat(join(root, 'media/files', result.selectionId!, '.pending'));
    const response = await serve(media.id);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(await response.text()).toBe('img:640x480');
    expect((await library.respond(new Request(`threads-media://file/${media.id}`))).status).toBe(
      404,
    );
    expect(library.staged({ ...scope, ownerId: 'owner-2' }, result.selectionId!)).toBeNull();
  });

  it.each([
    ['anim.gif', 'img:640x480', 'daily_media_format'],
    ['clip.webm', '{}', 'daily_media_format'],
    ['notes.txt', 'x', 'daily_media_format'],
    ['broken.png', 'not an image', 'daily_media_image'],
    ['narrow.png', 'img:300x480', 'daily_media_image'],
    ['banner.png', 'img:4400x400', 'daily_media_image'],
    ['empty.png', '', 'daily_media_file'],
    ['slow.mp4', JSON.stringify(probe({ avg_frame_rate: '20/1' })), 'daily_media_video'],
    ['broken.mov', 'not a video', 'daily_media_video'],
  ])('refuses the whole batch for %s and names it', async (name, content, code) => {
    const good = await source('good.png', 'img:640x480');
    const result = await add([good, await source(name, content)]);
    expect(result).toMatchObject({ status: 'error', selectionId: null, media: [] });
    expect(result.problem).toMatchObject({ code });
    expect(result.problem!.message).toContain(`'${name}'`);
    expect(await readdir(join(root, 'media/files')).catch(() => [])).toEqual([]);
  });

  it('refuses images over 8 MiB, more files than room, links and folders', async () => {
    const big = await source('big.jpg', 'img:640x480');
    await truncate(big, 8 * 1024 * 1024 + 1);
    expect((await add([big])).problem?.code).toBe('daily_media_size');
    const small = await source('small.png', 'img:640x480');
    expect((await library.add(scope, { room: 1, paths: [small, small] })).problem?.code).toBe(
      'daily_media_count',
    );
    await symlink(small, join(sources, 'link.png'));
    expect((await add([join(sources, 'link.png')])).problem?.code).toBe('daily_media_file');
    await mkdir(join(sources, 'dir.png'));
    expect((await add([join(sources, 'dir.png')])).problem?.code).toBe('daily_media_file');
    expect((await library.add(scope, { room: 20, paths: ['relative.png'] })).problem?.code).toBe(
      'daily_media_input',
    );
  });

  it('stores a WebP as the PNG it became, hashing the PNG', async () => {
    const result = await add([await source('photo.webp', 'webp:800x600')]);
    const stored = library.staged(scope, result.selectionId!)!.get(result.media[0].id)!;
    expect(stored.relativePath).toMatch(/\.png$/);
    expect(stored.sha256).toBe(sha('img:800x600'));
    expect(stored.name).toBe('photo.webp');
    expect(await readdir(join(root, 'media/files', result.selectionId!))).toEqual(
      expect.not.arrayContaining([expect.stringMatching(/\.webp$/)]),
    );
  });

  it('adds to the same selection, and a new dialog drops the unsaved one', async () => {
    const first = await add([await source('a.png', 'img:640x480')]);
    const second = await add([await source('b.mp4', JSON.stringify(probe()))], {
      selectionId: first.selectionId,
    });
    expect(second.selectionId).toBe(first.selectionId);
    expect(library.staged(scope, first.selectionId!)!.size).toBe(2);
    expect(
      (await add([await source('c.png', 'img:640x480')], { selectionId: 'f'.repeat(32) })).problem
        ?.code,
    ).toBe('daily_media_selection');
    picked = [await source('d.png', 'img:640x480')];
    const next = await library.pick(scope, { room: 20 });
    expect(next.status).toBe('ok');
    expect(library.staged(scope, first.selectionId!)).toBeNull();
    await expect(stat(join(root, 'media/files', first.selectionId!))).rejects.toThrow();
    expect((await serve(first.media[0].id)).status).toBe(404);
  });

  it('reports a closed picker as cancelled and needs room', async () => {
    expect(await library.pick(scope, { room: 20 })).toEqual({
      status: 'cancelled',
      selectionId: null,
      media: [],
      problem: null,
    });
    expect((await library.pick(scope, { room: 0 })).problem?.code).toBe('daily_media_count');
    folder = null;
    expect(library.ready()).toBe(false);
    expect((await library.pick(scope, { room: 20 })).problem?.code).toBe('daily_media_folder');
    expect(library.uploadSource(scope)).toBeNull();
  });
});

describe('video rules', () => {
  it.each([
    ['accepts a 30 fps portrait video', probe(), true],
    ['accepts 60 fps', probe({ avg_frame_rate: '60/1' }), true],
    ['refuses 61 fps', probe({ avg_frame_rate: '61/1' }), false],
    ['refuses 22 fps', probe({ avg_frame_rate: '22/1' }), false],
    ['refuses an unknown rate', probe({ avg_frame_rate: '0/0' }), false],
    ['refuses VP9', probe({ codec_name: 'vp9' }), false],
    ['refuses a ratio over 10', probe({ width: 1100, height: 100 }), false],
    ['refuses a ratio under 0.01', probe({ width: 10, height: 1001 }), false],
    ['refuses over 5 minutes', probe({}, '300.5'), false],
    [
      'refuses non-AAC audio',
      { ...probe(), streams: [probe().streams[0], { codec_type: 'audio', codec_name: 'opus' }] },
      false,
    ],
    ['refuses no video stream', { streams: [], format: { duration: '1' } }, false],
  ])('%s', (_name, value, ok) => {
    expect(threadsVideo(value)).toBe(ok);
  });
});

describe('ending a selection', () => {
  it('discard stops a copy in progress and leaves nothing behind', async () => {
    let release!: () => void;
    overrides.probeVideo = async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return probe();
    };
    library = make();
    const first = await add([await source('a.png', 'img:640x480')]);
    const adding = add([await source('b.mp4', 'video')], { selectionId: first.selectionId });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const discarding = library.discard(scope, { selectionId: first.selectionId });
    release();
    expect(await adding).toMatchObject({ status: 'cancelled' });
    await discarding;
    await expect(stat(join(root, 'media/files', first.selectionId!))).rejects.toThrow();
    expect((await serve(first.media[0].id)).status).toBe(404);
  });

  it('discard never follows a selection folder swapped for a link', async () => {
    const first = await add([await source('a.png', 'img:640x480')]);
    const selection = join(root, 'media/files', first.selectionId!);
    // Another folder takes the selection's place through a link, holding a same-named file.
    const elsewhere = join(base, 'elsewhere');
    await mkdir(elsewhere);
    const name = `${first.media[0].id}.png`;
    await writeFile(join(elsewhere, name), 'keep me');
    await rm(selection, { recursive: true, force: true });
    await symlink(elsewhere, selection);
    await library.discard(scope, { selectionId: first.selectionId });
    expect(await readFile(join(elsewhere, name), 'utf8')).toBe('keep me');
  });

  it('discard aborts a running stream copy', async () => {
    const first = await add([await source('a.png', 'img:640x480')]);
    const large = await source('large.mp4', Buffer.alloc(64 * 1024 * 1024));
    const adding = add([large], { selectionId: first.selectionId });
    await library.discard(scope, { selectionId: first.selectionId });
    expect(await adding).toMatchObject({ status: 'cancelled' });
    await expect(readdir(join(root, 'media/files'))).resolves.toEqual([]);
  });

  it('commit keeps the saved files, drops the rest and the pending mark', async () => {
    const result = await add([
      await source('a.png', 'img:640x480'),
      await source('b.png', 'img:640x480'),
    ]);
    const [kept, dropped] = result.media;
    await library.commit(scope, result.selectionId!, new Set([kept.id]));
    expect(library.staged(scope, result.selectionId!)).toBeNull();
    const files = await readdir(join(root, 'media/files', result.selectionId!));
    expect(files).toEqual([`${kept.id}.png`]);
    expect((await serve(kept.id)).status).toBe(200);
    expect((await serve(dropped.id)).status).toBe(404);
  });
});

describe('saved files', () => {
  const saved = async (selection: string, id: string, content = 'img:640x480') => {
    await mkdir(join(root, 'media/files', selection), { recursive: true });
    await writeFile(join(root, 'media/files', selection, `${id}.png`), content);
    return {
      id,
      kind: 'image' as const,
      name: `${id}.png`,
      relativePath: `media/files/${selection}/${id}.png`,
      size: content.length,
      sha256: sha(content),
    };
  };

  it('tracks what is there, serves it, and offers it for upload', async () => {
    const present = await saved('1'.repeat(32), 'a'.repeat(32));
    const missing = {
      ...present,
      id: 'b'.repeat(32),
      relativePath: present.relativePath.replace('a'.repeat(32), 'b'.repeat(32)),
    };
    expect(await library.track(scope, [present, missing])).toEqual(new Set([present.id]));
    expect(await (await serve(present.id)).text()).toBe('img:640x480');
    expect((await serve(missing.id)).status).toBe(404);
    const upload = library.uploadSource(scope)!;
    expect(upload.root).toBe(root);
    const copy = join(base, 'frozen.png');
    expect(await upload.registry.copyForUpload(upload.root, present.id, copy)).toMatchObject({
      sha256: present.sha256,
    });
    library.reset();
    expect((await serve(present.id)).status).toBe(404);
    await stat(join(root, present.relativePath));
  });

  it('removes files inside the partition only, with their empty folder', async () => {
    const one = await saved('1'.repeat(32), 'a'.repeat(32));
    const two = await saved('2'.repeat(32), 'b'.repeat(32));
    const three = await saved('2'.repeat(32), 'c'.repeat(32));
    await writeFile(join(work, 'outside.png'), 'x');
    await library.track(scope, [one, two, three]);
    await library.remove(scope, [
      one,
      two,
      { ...three, relativePath: '../../outside.png' },
      { ...three, id: 'd'.repeat(32) },
    ]);
    await expect(stat(join(root, 'media/files', '1'.repeat(32)))).rejects.toThrow();
    expect(await readdir(join(root, 'media/files', '2'.repeat(32)))).toEqual([`${three.id}.png`]);
    await stat(join(work, 'outside.png'));
    expect((await serve(two.id)).status).toBe(404);
    expect((await serve(three.id)).status).toBe(200);
  });

  it('sweeps pending folders only, keeping referenced files and the open selection', async () => {
    const pending = '1'.repeat(32);
    const settled = '2'.repeat(32);
    const used = await saved(pending, 'a'.repeat(32));
    await saved(pending, 'b'.repeat(32));
    await writeFile(join(root, 'media/files', pending, `${'c'.repeat(32)}.webp`), 'webp:1x1');
    await writeFile(join(root, 'media/files', pending, '.pending'), '');
    await saved(settled, 'd'.repeat(32));
    const orphan = await saved('3'.repeat(32), 'e'.repeat(32));
    await writeFile(join(root, 'media/files', '3'.repeat(32), '.pending'), '');
    const open = await add([await source('open.png', 'img:640x480')]);
    await library.sweep(scope, new Set([used.id]));
    expect(await readdir(join(root, 'media/files', pending))).toEqual([`${used.id}.png`]);
    expect(await readdir(join(root, 'media/files', settled))).toEqual([`${'d'.repeat(32)}.png`]);
    await expect(stat(join(root, 'media/files', '3'.repeat(32)))).rejects.toThrow();
    expect(orphan.id).toBe('e'.repeat(32));
    expect(library.staged(scope, open.selectionId!)!.size).toBe(1);
    await stat(join(root, 'media/files', open.selectionId!, '.pending'));
  });
});
