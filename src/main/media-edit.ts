import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { CollectionView, MediaEditInput, MediaEditResult } from '../shared/contracts';
import { ViewError } from './collection';
import { pythonCommand } from './python';

const MAX_SIDE = 8192;
const MAX_PIXELS = 40_000_000;
const MAX_PNG_BYTES = 64 * 1024 * 1024;
const mediaId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nonnegativeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const dimensions = (width: unknown, height: unknown): width is number =>
  nonnegativeInteger(width) &&
  nonnegativeInteger(height) &&
  width > 0 &&
  height > 0 &&
  width <= MAX_SIDE &&
  height <= MAX_SIDE &&
  width * height <= MAX_PIXELS;

export function parseMediaEditInput(value: unknown): MediaEditInput {
  const invalid = () => {
    throw new ViewError('edit_input', '편집 범위나 이미지 데이터가 올바르지 않습니다.');
  };
  if (
    !object(value) ||
    typeof value.postKey !== 'string' ||
    !value.postKey ||
    value.postKey.length > 512 ||
    !mediaId(value.mediaId)
  )
    return invalid();
  const identity = { postKey: value.postKey, mediaId: value.mediaId };
  if (value.kind === 'crop') {
    const crop = value.crop;
    if (
      !object(crop) ||
      !nonnegativeInteger(crop.x) ||
      !nonnegativeInteger(crop.y) ||
      !dimensions(crop.width, crop.height) ||
      !nonnegativeInteger(crop.height) ||
      crop.x + crop.width > MAX_SIDE ||
      crop.y + crop.height > MAX_SIDE
    )
      return invalid();
    return {
      ...identity,
      kind: 'crop',
      crop: { x: crop.x, y: crop.y, width: crop.width, height: crop.height },
    };
  }
  if (value.kind === 'capture') {
    if (
      !(value.png instanceof Uint8Array) ||
      value.png.byteLength < 33 ||
      value.png.byteLength > MAX_PNG_BYTES ||
      typeof value.time !== 'number' ||
      !Number.isFinite(value.time) ||
      value.time < 0
    )
      return invalid();
    const png = Buffer.from(value.png.buffer, value.png.byteOffset, value.png.byteLength);
    if (
      !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR' ||
      !dimensions(png.readUInt32BE(16), png.readUInt32BE(20))
    )
      return invalid();
    return { ...identity, kind: 'capture', png: new Uint8Array(png), time: value.time };
  }
  if (value.kind === 'trim') {
    if (
      typeof value.start !== 'number' ||
      typeof value.end !== 'number' ||
      !Number.isFinite(value.start) ||
      !Number.isFinite(value.end) ||
      value.start < 0 ||
      value.end <= value.start
    )
      return invalid();
    return { ...identity, kind: 'trim', start: value.start, end: value.end };
  }
  return invalid();
}

export type MediaEditCommand =
  | {
      root: string;
      postKey: string;
      mediaId: string;
      kind: 'crop';
      crop: { x: number; y: number; width: number; height: number };
    }
  | {
      root: string;
      postKey: string;
      mediaId: string;
      kind: 'capture';
      pngBase64: string;
      time: number;
    }
  | {
      root: string;
      postKey: string;
      mediaId: string;
      kind: 'trim';
      start: number;
      end: number;
    };
export type LaunchMediaEdit = (input: MediaEditCommand) => {
  result: Promise<string>;
  cancel(): void;
};

export function parseMediaEditResult(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate the worker contract below. */
  }
  if (object(value)) {
    if (value.ok === true && mediaId(value.mediaId)) return value.mediaId;
    if (
      value.ok === false &&
      object(value.error) &&
      typeof value.error.code === 'string' &&
      /^[a-z_]{1,64}$/.test(value.error.code) &&
      typeof value.error.message === 'string' &&
      value.error.message.length <= 2000
    )
      throw new ViewError(value.error.code, value.error.message);
  }
  throw new ViewError(
    'edit_response',
    '편집 저장 결과를 확인하지 못했습니다. 새로고침하여 저장 여부를 먼저 확인하세요.',
  );
}

export function launchMediaEdit(projectRoot: string): LaunchMediaEdit {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    // ffmpeg has its own 30-minute limit; leave time for source/output validation
    // and cleanup so its specific failure can reach the renderer first.
    const timeout = input.kind === 'trim' ? 1_920_000 : 120_000;
    let cancel = () => {};
    const result = new Promise<string>((resolve, reject) => {
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'edit_media.py')],
        { timeout, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(watchdog);
          try {
            // Success is emitted after commit. Preserve it even if shutdown races
            // with process exit so an already saved edit is never offered as a retry.
            resolve(parseMediaEditResult(stdout));
          } catch (error) {
            reject(error);
          }
        },
      );
      cancel = () => {
        if (closed) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 40_000);
      };
      const watchdog = setTimeout(() => cancel(), timeout);
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(input));
    });
    return { result, cancel: () => cancel() };
  };
}

export class MediaEditController {
  private pending: Promise<MediaEditResult> | null = null;
  private job: ReturnType<LaunchMediaEdit> | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private launch: LaunchMediaEdit,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  save(root: string, input: unknown): Promise<MediaEditResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: { code: 'edit_busy', message: '진행 중인 작업이 끝난 뒤 편집본을 저장하세요.' },
      });
    this.cancelled = false;
    this.pending = this.run(root, input).finally(() => {
      this.job = null;
      this.pending = null;
    });
    return this.pending;
  }
  private async run(root: string, rawInput: unknown): Promise<MediaEditResult> {
    try {
      const input = parseMediaEditInput(rawInput);
      const before = await this.refresh(root);
      if (this.cancelled) throw new ViewError('edit_cancelled', '편집 저장을 중지했습니다.');
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      const post =
        before.snapshot?.root === root
          ? before.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      const source =
        post &&
        [...post.attachments, ...(post.edits ?? [])].find((item) => item.mediaId === input.mediaId);
      if (
        !source ||
        source.status !== 'saved' ||
        source.localUrl !== `threads-media://file/${input.mediaId}` ||
        source.kind !== (input.kind === 'crop' ? 'image' : 'video')
      )
        throw new ViewError(
          'edit_source',
          '편집할 원본 파일을 찾을 수 없습니다. 목록을 새로고침하세요.',
        );
      const command: MediaEditCommand =
        input.kind === 'crop'
          ? { root, postKey: input.postKey, mediaId: input.mediaId, kind: 'crop', crop: input.crop }
          : input.kind === 'trim'
            ? {
                root,
                postKey: input.postKey,
                mediaId: input.mediaId,
                kind: 'trim',
                start: input.start,
                end: input.end,
              }
            : {
                root,
                postKey: input.postKey,
                mediaId: input.mediaId,
                kind: 'capture',
                pngBase64: Buffer.from(input.png).toString('base64'),
                time: input.time,
              };
      this.job = this.launch(command);
      const savedId = await this.job.result;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { ...before, error: { code: 'edit_refresh_failed', message: '' } };
      }
      if (view.error || view.snapshot?.root !== root)
        view = {
          ...view,
          snapshot: view.snapshot?.root === root ? view.snapshot : before.snapshot,
          error: {
            code: 'edit_refresh_failed',
            message:
              '편집본은 저장됐지만 목록을 갱신하지 못했습니다. 다시 저장하지 말고 새로고침하세요.',
          },
        };
      return { status: 'saved', mediaId: savedId, view };
    } catch (error) {
      return {
        status: 'error',
        problem: this.cancelled
          ? { code: 'edit_cancelled', message: '편집 저장을 중지했습니다.' }
          : error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'edit_failed',
                message: '편집본을 저장하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
              },
      };
    }
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.job?.cancel();
    await this.pending;
  }
}
