import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream, realpathSync, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rm, rmdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { nativeImage } from 'electron';
import { DAILY_MEDIA_SCHEME } from '../shared/contracts';
import { DAILY_MEDIA_LIMIT, type DailyMedia, type DailyMediaResult } from '../shared/daily';
import { ViewError } from './collection';
import type { DailyScope } from './daily-store';
import { MediaRegistry, type LocalFile } from './media';
import { mediaCommand } from './runtime';

/**
 * One attachment as `daily.json` keeps it (2026-11-24). `relativePath` is
 * `media/files/<selection 32hex>/<id 32hex>.<ext>` under the partition folder
 * `<work folder>/daily-media/<partition 32hex>`, so `MediaRegistry` can serve and upload it.
 * `sha256` and `size` describe the stored bytes (a WebP is stored as the PNG it became).
 */
export interface StoredDailyMedia extends LocalFile {
  /** The original file name, shown under the thumbnail. */
  name: string;
}

export interface DailyMediaOptions {
  /** The work folder in use now, or null when none is set. */
  workFolder(): string | null;
  /** Opens the OS file picker for images and videos; null when it is closed without choosing. */
  pickFiles(): Promise<string[] | null>;
  /** Converts a WebP into a PNG with the bundled Pillow (`launchWebpToPng`). */
  webpToPng(source: string, target: string): Promise<void>;
  /** Pixel size of a stored JPEG or PNG; null when it cannot be decoded. Defaults to `nativeImage`. */
  imageSize?(path: string): Promise<{ width: number; height: number } | null>;
  /** The parsed `ffprobe` JSON of a stored video. Defaults to the app's ffprobe. */
  probeVideo?(path: string): Promise<unknown>;
}

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'];
const VIDEO_EXTENSIONS = ['mp4', 'mov'];
const IMAGE_LIMIT = 8 * 1024 * 1024;
/** A WebP may shrink when it becomes a PNG; the stored PNG is held to `IMAGE_LIMIT`. */
const WEBP_LIMIT = 32 * 1024 * 1024;
const VIDEO_LIMIT = 1024 ** 3;
const HEX = /^[a-f0-9]{32}$/;
const STORED_PATH = /^media\/files\/([a-f0-9]{32})\/([a-f0-9]{32})\.(jpg|jpeg|png|mp4|mov)$/;
const PENDING = '.pending';
const newId = () => randomUUID().replaceAll('-', '');
const signature = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>) => Object.keys(value).sort().join(',');

async function nativeImageSize(path: string) {
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? null : image.getSize();
}

/** The same ffprobe call as `checkVideo` in `threads-media.ts`, with size and frame rate too. */
function ffprobe(path: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      mediaCommand('ffprobe'),
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-format_whitelist',
        'mov',
        '-enable_drefs',
        '0',
        '-use_absolute_path',
        '0',
        '-i',
        path,
        '-show_entries',
        'stream=codec_type,codec_name,width,height,avg_frame_rate:format=duration',
        '-of',
        'json',
      ],
      {
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        },
      },
      (error, stdout) => {
        try {
          if (error) throw error;
          resolve(JSON.parse(stdout));
        } catch (failure) {
          reject(failure);
        }
      },
    );
  });
}

/**
 * Threads video rules (2026-11-24): `checkVideo`'s (a video stream, at most 5 minutes, H.264 or
 * HEVC video, AAC audio) plus 23–60 frames per second and an aspect ratio of 0.01–10.
 */
export function threadsVideo(probe: unknown): boolean {
  if (!object(probe) || !Array.isArray(probe.streams) || !object(probe.format)) return false;
  const streams = probe.streams.filter(object);
  const duration = Number(probe.format.duration);
  const video = streams.find((s) => s.codec_type === 'video');
  if (
    !video ||
    streams.length !== probe.streams.length ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 300 ||
    streams.some(
      (s) => s.codec_type === 'video' && !['h264', 'hevc'].includes(s.codec_name as string),
    ) ||
    streams.some((s) => s.codec_type === 'audio' && s.codec_name !== 'aac')
  )
    return false;
  const { width, height } = video;
  const rate = /^(\d+)\/(\d+)$/.exec(String(video.avg_frame_rate));
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !(width > 0) ||
    !(height > 0) ||
    !rate ||
    Number(rate[2]) <= 0
  )
    return false;
  const fps = Number(rate[1]) / Number(rate[2]);
  const ratio = width / height;
  return fps >= 23 && fps <= 60 && ratio >= 0.01 && ratio <= 10;
}

async function digestFile(path: string) {
  const digest = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
    size += chunk.length;
    digest.update(chunk);
  }
  return { size, sha256: digest.digest('hex') };
}

interface Selection {
  id: string;
  /** `<root>/media/files/<id>`. */
  directory: string;
  files: Map<string, StoredDailyMedia>;
}

/** What one partition of the work folder in use holds in memory. */
interface Space {
  workFolder: string;
  partition: string;
  /** The partition folder, resolved from the work folder's real path. */
  root: string;
  registry: MediaRegistry;
  /** The files saved posts point to (`track`). */
  tracked: StoredDailyMedia[];
  /** The open dialog's selection; one per partition. */
  selection: Selection | null;
}

/**
 * The attachments of daily posts (2026-11-24): a dialog's selection of newly added files, the
 * files saved posts point to, their preview (`threads-daily://file/<id>`) and their cleanup.
 * Files are copies in the work folder, like the collection's own posts; nothing here reads or
 * writes `daily.json` — the daily controller passes what the posts hold.
 */
export class DailyMediaLibrary {
  private space: Space | null = null;
  /** A pick or add in progress; only one runs at a time. */
  private pending: Promise<DailyMediaResult> | null = null;
  private choosing = false;
  private generation = 0;
  private abort: AbortController | null = null;
  /** The id of a selection being created, not yet in `space.selection`. */
  private creating: string | null = null;
  private registering: Promise<unknown> = Promise.resolve();
  private readonly imageSize: NonNullable<DailyMediaOptions['imageSize']>;
  private readonly probeVideo: NonNullable<DailyMediaOptions['probeVideo']>;

  constructor(private readonly options: DailyMediaOptions) {
    this.imageSize = options.imageSize ?? nativeImageSize;
    this.probeVideo = options.probeVideo ?? ffprobe;
  }

  /** The partition folder name: 32 hex of sha256 of `${service}\n${ownerId}`. */
  static partition(scope: DailyScope): string {
    return createHash('sha256')
      .update(`${scope.service}\n${scope.ownerId}`)
      .digest('hex')
      .slice(0, 32);
  }

  /** Attachments can be added and shown: a work folder is set. */
  ready(): boolean {
    return this.options.workFolder() !== null;
  }

  /** IPC: opens the file picker and stages the chosen files into the dialog's selection. */
  pick(scope: DailyScope, input: unknown): Promise<DailyMediaResult> {
    if (!object(input) || !['room', 'room,selectionId'].includes(keys(input)))
      return Promise.resolve(failed(inputError()));
    return this.begin(scope, input, null);
  }

  /** IPC: stages dropped files (`{ selectionId?, room, paths }`) into the dialog's selection. */
  add(scope: DailyScope, input: unknown): Promise<DailyMediaResult> {
    if (
      !object(input) ||
      !['paths,room', 'paths,room,selectionId'].includes(keys(input)) ||
      !Array.isArray(input.paths) ||
      input.paths.length < 1 ||
      input.paths.length > 100 ||
      !input.paths.every(
        (path) =>
          typeof path === 'string' &&
          path.length <= 32768 &&
          !path.includes('\0') &&
          isAbsolute(path),
      )
    )
      return Promise.resolve(failed(inputError()));
    return this.begin(scope, input, [...(input.paths as string[])]);
  }

  private begin(
    scope: DailyScope,
    input: Record<string, unknown>,
    paths: string[] | null,
  ): Promise<DailyMediaResult> {
    const { room, selectionId } = input;
    if (
      !Number.isSafeInteger(room) ||
      (room as number) < 0 ||
      (room as number) > DAILY_MEDIA_LIMIT ||
      (selectionId !== undefined && (typeof selectionId !== 'string' || !HEX.test(selectionId)))
    )
      return Promise.resolve(failed(inputError()));
    if (this.pending)
      return Promise.resolve(
        failed(new ViewError('daily_media_busy', '첨부하는 중입니다. 끝난 뒤 다시 시도하세요.')),
      );
    const space = this.locate(scope);
    if (!space) return Promise.resolve(failed(folderError()));
    const generation = ++this.generation;
    this.abort = new AbortController();
    const pending = this.run(
      space,
      generation,
      this.abort.signal,
      room as number,
      selectionId as string | undefined,
      paths,
    ).finally(() => {
      this.pending = null;
      this.abort = null;
      this.creating = null;
    });
    this.pending = pending;
    return pending;
  }

  private assertCurrent(space: Space, generation: number): void {
    if (generation !== this.generation) throw new Cancelled();
    if (this.space !== space || this.options.workFolder() !== space.workFolder)
      throw new ViewError('daily_media_folder', '작업 폴더가 바뀌었습니다. 다시 첨부하세요.');
  }

  private async run(
    space: Space,
    generation: number,
    signal: AbortSignal,
    room: number,
    selectionId: string | undefined,
    chosen: string[] | null,
  ): Promise<DailyMediaResult> {
    let fresh: Selection | null = null;
    const created: string[] = [];
    let staged = false;
    try {
      let selection = space.selection;
      if (selectionId === undefined) {
        // A new dialog: what an earlier one left unsaved is no longer wanted.
        if (selection) {
          space.selection = null;
          await removeDirectory(selection.directory);
          await this.publish(space);
        }
        selection = null;
      } else if (!selection || selection.id !== selectionId)
        throw new ViewError(
          'daily_media_selection',
          '이 창의 첨부를 찾지 못했습니다. 창을 닫고 다시 첨부하세요.',
        );
      if (room < 1) throw countError(room);
      let paths = chosen;
      if (!paths) {
        this.choosing = true;
        try {
          paths = await this.options.pickFiles();
        } finally {
          this.choosing = false;
        }
      }
      this.assertCurrent(space, generation);
      if (!paths?.length)
        return { status: 'cancelled', selectionId: null, media: [], problem: null };
      if (paths.length > room) throw countError(room);
      for (const path of paths) {
        if (
          !IMAGE_EXTENSIONS.includes(extension(path)) &&
          !VIDEO_EXTENSIONS.includes(extension(path))
        )
          throw new ViewError(
            'daily_media_format',
            `'${basename(path)}' 파일은 Threads에 올릴 수 없는 형식입니다. JPG·PNG·WEBP 이미지나 MP4·MOV 영상을 첨부하세요.`,
          );
      }
      if (!selection) {
        const id = newId();
        fresh = { id, directory: join(space.root, 'media', 'files', id), files: new Map() };
        this.creating = id;
        await mkdir(fresh.directory, { recursive: true, mode: 0o700 });
        if ((await realpath(fresh.directory)) !== fresh.directory) throw new Error('Not a folder');
        await writeFile(join(fresh.directory, PENDING), '', { flag: 'wx', mode: 0o600 });
        selection = fresh;
      }
      const added: StoredDailyMedia[] = [];
      for (const path of paths) {
        this.assertCurrent(space, generation);
        added.push(await this.stage(path, selection, signal, created));
      }
      this.assertCurrent(space, generation);
      for (const file of added) selection.files.set(file.id, file);
      if (fresh) space.selection = fresh;
      staged = true;
      await this.publish(space);
      return {
        status: 'ok',
        selectionId: selection.id,
        media: added.map((file) => this.media(file)),
        problem: null,
      };
    } catch (error) {
      if (generation !== this.generation || error instanceof Cancelled)
        return { status: 'cancelled', selectionId: null, media: [], problem: null };
      return failed(error);
    } finally {
      if (!staged) {
        // All or nothing: a refused or stopped batch leaves none of its copies behind.
        await Promise.all(created.map((path) => rm(path, { force: true }).catch(() => {})));
        if (fresh) await removeDirectory(fresh.directory).catch(() => {});
      }
    }
  }

  /** Copies one file like `stageFile` in `local-post.ts`, then checks it against Threads' rules. */
  private async stage(
    source: string,
    selection: Selection,
    signal: AbortSignal,
    created: string[],
  ): Promise<StoredDailyMedia> {
    const name = basename(source);
    const refuse = (code: string, reason: string) =>
      new ViewError(code, `'${name}' 파일은 ${reason}`);
    const changed = () =>
      new ViewError(
        'daily_media_changed',
        `'${name}' 파일이 복사하는 동안 바뀌었습니다. 다시 첨부하세요.`,
      );
    try {
      let ext = extension(source);
      const kind: 'image' | 'video' = IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video';
      const before = await lstat(source);
      if (!before.isFile() || before.isSymbolicLink())
        throw refuse(
          'daily_media_file',
          '바로가기나 폴더입니다. 실제 이미지·영상 파일을 첨부하세요.',
        );
      if (before.size <= 0) throw refuse('daily_media_file', '비어 있습니다.');
      if (kind === 'video' && before.size > VIDEO_LIMIT)
        throw refuse('daily_media_size', '1GB를 넘습니다. Threads 영상은 1GB 이하여야 합니다.');
      if (kind === 'image' && before.size > (ext === 'webp' ? WEBP_LIMIT : IMAGE_LIMIT))
        throw refuse('daily_media_size', '8MB를 넘습니다. Threads 이미지는 8MB 이하여야 합니다.');
      const id = newId();
      let path = join(selection.directory, `${id}.${ext}`);
      const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let size = 0;
      let sha256: string;
      try {
        if (signature(before) !== signature(await handle.stat())) throw changed();
        const digest = createHash('sha256');
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.length;
            if (size > before.size) return callback(changed());
            digest.update(chunk);
            callback(null, chunk);
          },
        });
        created.push(path);
        await pipeline(
          handle.createReadStream({ autoClose: false }),
          verify,
          createWriteStream(path, { flags: 'wx', mode: 0o600 }),
          { signal },
        );
        if (size !== before.size || signature(before) !== signature(await handle.stat()))
          throw changed();
        sha256 = digest.digest('hex');
      } finally {
        await handle.close();
      }
      if (kind === 'image') {
        if (ext === 'webp') {
          const png = join(selection.directory, `${id}.png`);
          created.push(png);
          try {
            await this.options.webpToPng(path, png);
          } catch {
            throw refuse(
              'daily_media_image',
              'PNG로 바꾸지 못했습니다. 손상되지 않은 파일을 첨부하세요.',
            );
          }
          await rm(path, { force: true });
          ext = 'png';
          path = png;
          ({ size, sha256 } = await digestFile(png));
          if (size > IMAGE_LIMIT)
            throw refuse(
              'daily_media_size',
              'PNG로 바꾸면 8MB를 넘습니다. Threads 이미지는 8MB 이하여야 합니다.',
            );
        }
        const dimensions = await this.imageSize(path).catch(() => null);
        if (!dimensions || !(dimensions.width > 0) || !(dimensions.height > 0))
          throw refuse(
            'daily_media_image',
            '열 수 없는 이미지입니다. 손상되지 않은 파일을 첨부하세요.',
          );
        const { width, height } = dimensions;
        if (width < 320)
          throw refuse(
            'daily_media_image',
            '가로가 320픽셀보다 작습니다. Threads 이미지는 가로 320픽셀 이상이어야 합니다.',
          );
        if (Math.max(width, height) / Math.min(width, height) > 10)
          throw refuse('daily_media_image', '가로세로 비율이 10:1을 넘습니다.');
      } else {
        const probe = await this.probeVideo(path).catch(() => null);
        if (!threadsVideo(probe))
          throw refuse(
            'daily_media_video',
            'Threads 영상 조건에 맞지 않습니다. 5분 이하, H.264 또는 HEVC 영상과 AAC 음성, 초당 23~60프레임, 가로세로 비율 10:1 이하여야 합니다. ffprobe 실행 환경도 확인하세요.',
          );
      }
      return {
        id,
        kind,
        relativePath: `media/files/${selection.id}/${id}.${ext}`,
        size,
        sha256,
        name,
      };
    } catch (error) {
      if (error instanceof ViewError || signal.aborted) throw error;
      throw refuse(
        'daily_media_failed',
        '첨부하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
      );
    }
  }

  /** IPC: drops a selection that was not saved (`{ selectionId }`), stopping a copy in progress. */
  async discard(scope: DailyScope, input: unknown): Promise<void> {
    if (!object(input) || keys(input) !== 'selectionId' || typeof input.selectionId !== 'string')
      return;
    const space = this.current(scope);
    const selection = space?.selection;
    if (!space || !selection || selection.id !== input.selectionId) return;
    if (this.pending) {
      this.halt();
      // The native picker must be allowed to close with its owner window.
      if (!this.choosing) await this.pending;
    }
    if (space.selection !== selection) return;
    space.selection = null;
    await removeDirectory(selection.directory);
    await this.publish(space);
  }

  /** The files staged in one selection of this scope, by id; null for no such selection. */
  staged(scope: DailyScope, selectionId: string): ReadonlyMap<string, StoredDailyMedia> | null {
    const selection = this.current(scope)?.selection;
    return selection?.id === selectionId ? selection.files : null;
  }

  /**
   * After the post that uses a selection was saved: keeps the `kept` ids, deletes the selection's
   * other files and its pending mark, and forgets the selection.
   */
  async commit(scope: DailyScope, selectionId: string, kept: ReadonlySet<string>): Promise<void> {
    const space = this.current(scope);
    const selection = space?.selection;
    if (!space || !selection || selection.id !== selectionId) return;
    if (this.pending) {
      // Files still arriving were not part of what was saved.
      this.halt();
      if (!this.choosing) await this.pending;
    }
    if (space.selection !== selection) return;
    space.selection = null;
    const keep = [...selection.files.values()].filter((file) => kept.has(file.id));
    space.tracked = [...space.tracked.filter((file) => !kept.has(file.id)), ...keep];
    for (const file of selection.files.values())
      if (!kept.has(file.id))
        await rm(join(space.root, ...file.relativePath.split('/')), { force: true });
    await rm(join(selection.directory, PENDING), { force: true });
    if (!keep.length) await removeEmpty(selection.directory);
    await this.publish(space);
  }

  /**
   * Registers the files saved posts point to, for preview and upload, without reading their bytes
   * (the upload checks them). Replaces what was registered before. Returns the ids whose file is
   * there; a missing file is left out instead of failing the rest.
   */
  async track(scope: DailyScope, files: readonly StoredDailyMedia[]): Promise<Set<string>> {
    const space = this.locate(scope);
    if (!space) return new Set();
    space.tracked = [...files];
    const registered = new Set(await this.publish(space));
    return new Set(files.map((file) => file.id).filter((id) => registered.has(id)));
  }

  /** The preview address of one attachment. */
  url(id: string): string {
    return `${DAILY_MEDIA_SCHEME}://file/${id}`;
  }

  /** Serves `threads-daily://file/<id>` from the registered files (GET/HEAD, ranges). */
  respond(request: Request): Promise<Response> {
    if (!/^threads-daily:\/\/file\/[a-f0-9]{32}$/.test(request.url) || !this.space)
      return Promise.resolve(new Response(null, { status: 404 }));
    return this.space.registry.respond(
      new Request(request.url.replace(`${DAILY_MEDIA_SCHEME}:`, 'threads-media:'), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      }),
    );
  }

  /** Where `prepareThreadsMedia` reads registered files from; null without a work folder. */
  uploadSource(scope: DailyScope): { registry: MediaRegistry; root: string } | null {
    const space = this.locate(scope);
    return space && { registry: space.registry, root: space.root };
  }

  /**
   * Deletes the files of removed attachments or posts, after `daily.json` no longer has them.
   * Best effort: a path that is malformed or outside the partition folder is left alone.
   */
  async remove(scope: DailyScope, files: readonly StoredDailyMedia[]): Promise<void> {
    const space = this.locate(scope);
    if (!space) return;
    const removed = new Set<string>();
    const folders = new Set<string>();
    for (const file of files) {
      const match = STORED_PATH.exec(file.relativePath);
      if (!match || match[2] !== file.id) continue;
      const folder = join(space.root, 'media', 'files', match[1]);
      try {
        if ((await realpath(folder)) !== folder) continue;
        await rm(join(folder, `${match[2]}.${match[3]}`), { force: true });
        removed.add(file.id);
        folders.add(folder);
      } catch {
        /* Missing folder or not deletable: nothing more to do here. */
      }
    }
    for (const folder of folders)
      if (folder !== space.selection?.directory) await removeEmpty(folder);
    if (!removed.size) return;
    space.tracked = space.tracked.filter((file) => !removed.has(file.id));
    await this.publish(space);
  }

  /**
   * Cleans the selections a stopped app left marked pending, keeping the files posts still use.
   * Called once per sign-in on the first daily read, only after `daily.json` read cleanly.
   * `referenced` holds the attachment ids the partition's posts point to.
   */
  async sweep(scope: DailyScope, referenced: ReadonlySet<string>): Promise<void> {
    const space = this.locate(scope);
    if (!space) return;
    const files = join(space.root, 'media', 'files');
    let names: string[];
    try {
      if ((await realpath(files)) !== files) return;
      names = await readdir(files);
    } catch {
      return;
    }
    for (const name of names) {
      if (!HEX.test(name) || name === space.selection?.id || name === this.creating) continue;
      const folder = join(files, name);
      try {
        if (!(await lstat(folder)).isDirectory() || !(await lstat(join(folder, PENDING))).isFile())
          continue;
        for (const entry of await readdir(folder)) {
          const stored = /^([a-f0-9]{32})\.(jpg|jpeg|png|mp4|mov)$/.exec(entry);
          if (entry === PENDING || (stored && referenced.has(stored[1]))) continue;
          await rm(join(folder, entry), { recursive: true, force: true });
        }
        await rm(join(folder, PENDING), { force: true });
        await removeEmpty(folder);
      } catch {
        /* Left for the next sweep. */
      }
    }
  }

  /** Forgets selections and registered files (sign-out, another user). */
  reset(): void {
    this.halt();
    this.space = null;
  }

  private halt(): void {
    ++this.generation;
    this.abort?.abort();
  }

  private media(file: StoredDailyMedia): DailyMedia {
    return { id: file.id, kind: file.kind, name: file.name, url: this.url(file.id) };
  }

  /** The space of this scope in the work folder in use now, without switching to it. */
  private current(scope: DailyScope): Space | null {
    const space = this.space;
    return space &&
      space.workFolder === this.options.workFolder() &&
      space.partition === DailyMediaLibrary.partition(scope)
      ? space
      : null;
  }

  /** Like `current`, switching to this scope or work folder (stopping work on the old one). */
  private locate(scope: DailyScope): Space | null {
    const existing = this.current(scope);
    if (existing) return existing;
    const workFolder = this.options.workFolder();
    if (!workFolder) return null;
    let real: string;
    try {
      real = realpathSync.native(workFolder);
    } catch {
      return null;
    }
    this.halt();
    const partition = DailyMediaLibrary.partition(scope);
    this.space = {
      workFolder,
      partition,
      root: join(real, 'daily-media', partition),
      registry: new MediaRegistry(),
      tracked: [],
      selection: null,
    };
    return this.space;
  }

  /** Serves the tracked files and the open selection's; registrations run one at a time. */
  private publish(space: Space): Promise<string[]> {
    const run = this.registering.then(() =>
      space.registry.register(space.root, [
        ...space.tracked,
        ...(space.selection?.files.values() ?? []),
      ]),
    );
    this.registering = run.catch(() => {});
    return run;
  }
}

class Cancelled extends Error {}

const extension = (path: string) => extname(path).slice(1).toLowerCase();

const inputError = () => new ViewError('daily_media_input', '첨부할 파일을 확인하세요.');
const folderError = () =>
  new ViewError('daily_media_folder', '작업 폴더를 지정하면 이미지·영상을 첨부할 수 있습니다.');
const countError = (room: number) =>
  new ViewError(
    'daily_media_count',
    `한 글에는 이미지·영상을 최대 ${DAILY_MEDIA_LIMIT}개까지 첨부할 수 있습니다. 지금은 ${room}개 더 첨부할 수 있습니다.`,
  );

function failed(error: unknown): DailyMediaResult {
  return {
    status: 'error',
    selectionId: null,
    media: [],
    problem:
      error instanceof ViewError
        ? { code: error.code, message: error.message }
        : {
            code: 'daily_media_failed',
            message: '첨부하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
          },
  };
}

/**
 * Removes a selection folder this library made: only the files it names itself, and only while
 * the folder is still at its real path, so a folder swapped for a link is never followed.
 */
async function removeDirectory(path: string): Promise<void> {
  try {
    if ((await realpath(path)) !== path || !(await lstat(path)).isDirectory()) return;
    const entries = await readdir(path);
    // The pending mark goes last, so a folder left half way is still swept later.
    for (const entry of [...entries.filter((name) => name !== PENDING), PENDING]) {
      if (entry !== PENDING && !/^[a-f0-9]{32}\.(jpg|jpeg|png|webp|mp4|mov)$/.test(entry)) continue;
      const file = join(path, entry);
      if (entries.includes(entry) && (await lstat(file)).isFile()) await rm(file, { force: true });
    }
    await removeEmpty(path);
  } catch {
    /* Left for the next sweep. */
  }
}

async function removeEmpty(folder: string): Promise<void> {
  try {
    if (!(await readdir(folder)).length) await rmdir(folder);
  } catch {
    /* Already gone or still in use. */
  }
}
