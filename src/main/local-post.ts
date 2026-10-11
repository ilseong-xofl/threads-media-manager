import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream, type Stats } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type {
  CollectionView,
  CreateLocalPostInput,
  CreateLocalPostResult,
  LocalPostMedia,
  LocalPostMediaCurrent,
  PickLocalPostMediaResult,
  PostDraft,
} from '../shared/contracts';
import { validDraftCaption, validDraftMediaIds, validPostDraft } from '../shared/post-draft';
import { ViewError } from './collection';
import { MediaRegistry, type LocalFile } from './media';
import { pythonCommand } from './python';

export const LOCAL_POST_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4', 'mov', 'webm'];
const IMAGE_EXTENSIONS = new Set(LOCAL_POST_EXTENSIONS.slice(0, 5));
const id = () => randomUUID().replaceAll('-', '');
const signature = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const failure = (error: unknown) => ({
  status: 'error' as const,
  problem:
    error instanceof ViewError
      ? { code: error.code, message: error.message }
      : {
          code: 'local_post_failed',
          message: '새 글을 준비하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
        },
});

export function parseCreateLocalPostInput(value: unknown): CreateLocalPostInput {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'caption,mediaIds,selectionId' ||
    typeof value.selectionId !== 'string' ||
    !/^[a-f0-9]{32}$/.test(value.selectionId) ||
    !validDraftMediaIds(value.mediaIds) ||
    !validDraftCaption(value.caption)
  )
    throw new ViewError('local_post_input', '선택한 파일과 직접 작성한 캡션을 확인하세요.');
  return { selectionId: value.selectionId, mediaIds: [...value.mediaIds], caption: value.caption };
}

/** Internal IPC payload; the exposed preload API accepts File objects only. */
export interface AddLocalPostMediaInput {
  paths: string[];
  current?: LocalPostMediaCurrent;
}

export function parseAddLocalPostMediaInput(value: unknown): AddLocalPostMediaInput {
  if (
    !object(value) ||
    !['paths', 'current,paths'].includes(Object.keys(value).sort().join(',')) ||
    !Array.isArray(value.paths) ||
    value.paths.length < 1 ||
    value.paths.length > 100 ||
    !value.paths.every(
      (path) =>
        typeof path === 'string' &&
        path.length <= 32768 &&
        !path.includes('\0') &&
        isAbsolute(path),
    )
  )
    throw new ViewError(
      'local_post_drop',
      '내 컴퓨터의 이미지·영상 파일을 최대 100개까지 끌어다 놓으세요.',
    );
  const current = value.current;
  if (
    current !== undefined &&
    (!object(current) ||
      Object.keys(current).sort().join(',') !== 'mediaIds,selectionId' ||
      typeof current.selectionId !== 'string' ||
      !/^[a-f0-9]{32}$/.test(current.selectionId) ||
      !Array.isArray(current.mediaIds) ||
      (current.mediaIds.length > 0 && !validDraftMediaIds(current.mediaIds)))
  )
    throw new ViewError('local_post_selection', '기존 파일 선택을 확인한 뒤 다시 추가하세요.');
  return {
    paths: [...value.paths] as string[],
    ...(current === undefined
      ? {}
      : {
          current: {
            selectionId: current.selectionId as string,
            mediaIds: [...(current.mediaIds as string[])],
          },
        }),
  };
}

export interface LocalPostFile {
  path: string;
  mediaId: string;
  kind: 'image' | 'video';
  size: number;
  sha256: string;
}
export interface LocalPostCommand {
  root: string;
  postId: string;
  caption: string;
  files: LocalPostFile[];
}
export interface LocalPostReceipt {
  postKey: string;
  draft: PostDraft;
}
export type LaunchLocalPost = (input: LocalPostCommand) => {
  result: Promise<LocalPostReceipt>;
  cancel(): void;
};
export type LaunchLocalPostRecovery = (root: string) => {
  result: Promise<void>;
  cancel(): void;
};

export function parseLocalPostResult(raw: string, input: LocalPostCommand): LocalPostReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate below. */
  }
  if (object(value)) {
    if (
      value.ok === true &&
      value.postKey === JSON.stringify([':local:', input.postId]) &&
      validPostDraft(value.draft) &&
      value.draft.revision === 1 &&
      value.draft.caption === input.caption &&
      JSON.stringify(value.draft.mediaIds) ===
        JSON.stringify(input.files.map((file) => file.mediaId))
    )
      return { postKey: value.postKey as string, draft: value.draft };
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
    'local_post_response',
    '등록 결과를 확인하지 못했습니다. 다시 등록하지 말고 목록을 새로고침해 저장 여부를 먼저 확인하세요.',
  );
}

function launchWorker<T>(
  projectRoot: string,
  args: string[],
  input: unknown,
  parse: (raw: string) => T,
) {
  const { command, prefix } = pythonCommand(projectRoot);
  let cancel = () => {};
  const result = new Promise<T>((resolve, reject) => {
    let closed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const child = execFile(
      command,
      [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'local_post.py'), ...args],
      { timeout: 600_000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8' },
      (_error, stdout) => {
        closed = true;
        clearTimeout(killTimer);
        try {
          // A committed receipt remains successful during window/app shutdown.
          resolve(parse(stdout));
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
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify(input));
  });
  return { result, cancel: () => cancel() };
}

export function launchLocalPost(projectRoot: string): LaunchLocalPost {
  return (input) => launchWorker(projectRoot, [], input, (raw) => parseLocalPostResult(raw, input));
}

export function launchLocalPostRecovery(projectRoot: string): LaunchLocalPostRecovery {
  return (root) =>
    launchWorker(projectRoot, ['--recover'], { root }, (raw) => {
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch {
        /* Validate below. */
      }
      if (object(value)) {
        if (
          value.ok === true &&
          typeof value.recovered === 'number' &&
          Number.isSafeInteger(value.recovered) &&
          value.recovered >= 0
        )
          return;
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
        'local_post_recovery',
        '이전 직접 작성 글의 등록 상태를 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
      );
    });
}

interface Selection {
  id: string;
  root: string;
  directory: string;
  files: (LocalPostMedia & { file: LocalFile; path: string })[];
  registry: MediaRegistry;
}

async function stageFile(
  source: string,
  directory: string,
  selectionId: string,
  signal: AbortSignal,
  existing?: Selection['files'][number],
) {
  const extension = extname(source).slice(1).toLowerCase();
  if (!isAbsolute(source) || !LOCAL_POST_EXTENSIONS.includes(extension))
    throw new ViewError(
      'local_post_file',
      'JPG·PNG·WEBP·GIF 이미지 또는 MP4·MOV·WEBM 영상을 선택하세요.',
    );
  const kind: 'image' | 'video' = IMAGE_EXTENSIONS.has(extension) ? 'image' : 'video';
  const maximum = kind === 'image' ? 32 * 1024 * 1024 : 1024 ** 3;
  const before = await lstat(source);
  if (!before.isFile() || before.isSymbolicLink())
    throw new ViewError(
      'local_post_file',
      '바로가기나 폴더 대신 실제 이미지·영상 파일을 선택하세요.',
    );
  if (before.size <= 0 || before.size > maximum)
    throw new ViewError(
      'local_post_size',
      '이미지는 32 MiB, 영상은 1 GiB 이하의 비어 있지 않은 파일만 등록할 수 있습니다.',
    );
  if (existing && (before.size !== existing.file.size || kind !== existing.kind))
    throw new ViewError(
      'local_post_changed',
      '기존에 선택한 파일이 변경되었습니다. 파일을 다시 선택하세요.',
    );
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (signature(before) !== signature(await handle.stat()))
      throw new ViewError(
        'local_post_changed',
        '선택한 파일이 변경되었습니다. 파일을 다시 선택하세요.',
      );
    const mediaId = existing?.id ?? id();
    const relativePath = `media/files/${selectionId}/${mediaId}.${extension}`;
    const destination = join(directory, ...relativePath.split('/'));
    const digest = createHash('sha256');
    let size = 0;
    const verify = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += chunk.length;
        if (size > before.size) return callback(new Error('File changed'));
        digest.update(chunk);
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      verify,
      createWriteStream(destination, { flags: 'wx', mode: 0o600 }),
      { signal },
    );
    if (size !== before.size || signature(before) !== signature(await handle.stat()))
      throw new ViewError(
        'local_post_changed',
        '선택한 파일이 변경되었습니다. 파일을 다시 선택하세요.',
      );
    const sha256 = digest.digest('hex');
    if (existing && sha256 !== existing.file.sha256)
      throw new ViewError(
        'local_post_changed',
        '기존에 선택한 파일이 변경되었습니다. 파일을 다시 선택하세요.',
      );
    const file: LocalFile = { id: mediaId, relativePath, size, sha256, kind };
    return {
      id: mediaId,
      name: existing?.name ?? basename(source),
      kind,
      url: `threads-import://file/${mediaId}`,
      file,
      path: destination,
    };
  } finally {
    await handle.close();
  }
}

async function removeSelection(selection: Selection): Promise<void> {
  await selection.registry.adopt(selection.directory, []);
  await rm(selection.directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Paths arrive only from the native picker or the preload's Electron File extractor. */
export class LocalPostController {
  private selection: Selection | null = null;
  private pending: Promise<unknown> | null = null;
  private choosing = false;
  private creating = false;
  private generation = 0;
  private abort: AbortController | null = null;
  private job: { result: Promise<unknown>; cancel(): void } | null = null;
  constructor(
    private chooseFiles: () => Promise<string[] | null>,
    private refresh: (root: string) => Promise<CollectionView>,
    private launch: LaunchLocalPost,
    private currentRoot: () => string | null,
    private busy: () => boolean = () => false,
    private recover: LaunchLocalPostRecovery = () => ({ result: Promise.resolve(), cancel() {} }),
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  get hasSelection(): boolean {
    return this.selection !== null;
  }
  private assertCurrent(root: string, generation: number): void {
    if (generation !== this.generation)
      throw new ViewError('local_post_cancelled', '새 글 준비를 취소했습니다.');
    if (this.currentRoot() !== root)
      throw new ViewError(
        'local_post_folder',
        '작업 폴더가 변경되었습니다. 파일을 다시 선택하세요.',
      );
  }
  private busyResult() {
    return failure(
      new ViewError('local_post_busy', '진행 중인 작업이 끝난 뒤 새 글을 작성하세요.'),
    );
  }
  pick(root: string): Promise<PickLocalPostMediaResult> {
    if (this.active || this.busy()) return Promise.resolve(this.busyResult());
    return this.beginSelection(root);
  }
  add(root: string, value: unknown): Promise<PickLocalPostMediaResult> {
    if (this.active || this.busy()) return Promise.resolve(this.busyResult());
    try {
      return this.beginSelection(root, parseAddLocalPostMediaInput(value));
    } catch (error) {
      return Promise.resolve(failure(error));
    }
  }
  private beginSelection(
    root: string,
    input?: AddLocalPostMediaInput,
  ): Promise<PickLocalPostMediaResult> {
    const generation = ++this.generation;
    this.abort = new AbortController();
    const pending = this.runPick(root, generation, this.abort.signal, input).finally(() => {
      this.pending = null;
      this.abort = null;
      this.job = null;
    });
    this.pending = pending;
    return pending;
  }
  private async runPick(
    root: string,
    generation: number,
    signal: AbortSignal,
    input?: AddLocalPostMediaInput,
  ): Promise<PickLocalPostMediaResult> {
    let staged: Selection | null = null;
    try {
      this.assertCurrent(root, generation);
      let kept: Selection['files'] = [];
      if (input?.current) {
        const previous = this.selection;
        if (!previous || previous.id !== input.current.selectionId || previous.root !== root)
          throw new ViewError(
            'local_post_selection',
            '기존 파일 선택이 변경되었습니다. 파일을 다시 선택하세요.',
          );
        kept = input.current.mediaIds.map((mediaId) => {
          const file = previous.files.find((file) => file.id === mediaId);
          if (!file)
            throw new ViewError(
              'local_post_selection',
              '선택 목록에 없는 파일은 유지할 수 없습니다.',
            );
          return file;
        });
      }
      if (input && kept.length + input.paths.length > 100)
        throw new ViewError(
          'local_post_count',
          '한 게시글에는 이미지·영상을 최대 100개 선택할 수 있습니다.',
        );
      const recovery = this.recover(root);
      this.job = recovery;
      await recovery.result;
      this.job = null;
      this.assertCurrent(root, generation);
      const before = await this.refresh(root);
      this.assertCurrent(root, generation);
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      let paths: string[] | null;
      if (input) paths = input.paths;
      else {
        this.choosing = true;
        try {
          paths = await this.chooseFiles();
        } finally {
          this.choosing = false;
        }
      }
      this.assertCurrent(root, generation);
      if (!paths?.length) return { status: 'cancelled' };
      if (paths.length > 100)
        throw new ViewError(
          'local_post_count',
          '한 게시글에는 이미지·영상을 최대 100개 선택할 수 있습니다.',
        );
      const selectionId = id();
      const directory = await realpath(await mkdtemp(join(tmpdir(), 'tmm-local-post-')));
      staged = { id: selectionId, root, directory, files: [], registry: new MediaRegistry() };
      await mkdir(join(directory, 'media', 'files', selectionId), { recursive: true, mode: 0o700 });
      for (const file of kept) {
        this.assertCurrent(root, generation);
        staged.files.push(await stageFile(file.path, directory, selectionId, signal, file));
      }
      for (const path of paths) {
        this.assertCurrent(root, generation);
        staged.files.push(await stageFile(path, directory, selectionId, signal));
      }
      await staged.registry.adopt(
        directory,
        staged.files.map((file) => file.file),
      );
      this.assertCurrent(root, generation);
      const previous = this.selection;
      this.selection = staged;
      staged = null;
      if (previous) await removeSelection(previous).catch(() => {});
      return {
        status: 'selected',
        selectionId,
        files: this.selection.files.map(({ id, name, kind, url }) => ({ id, name, kind, url })),
      };
    } catch (error) {
      return generation !== this.generation ? { status: 'cancelled' } : failure(error);
    } finally {
      if (staged) await removeSelection(staged).catch(() => {});
    }
  }
  create(root: string, value: unknown): Promise<CreateLocalPostResult> {
    if (this.active || this.busy()) return Promise.resolve(this.busyResult());
    this.creating = true;
    const generation = this.generation;
    const pending = this.runCreate(root, value, generation).finally(() => {
      this.creating = false;
      this.job = null;
      this.pending = null;
    });
    this.pending = pending;
    return pending;
  }
  private async runCreate(
    root: string,
    value: unknown,
    generation: number,
  ): Promise<CreateLocalPostResult> {
    let committed: Selection | null = null;
    let attempted = false;
    try {
      const input = parseCreateLocalPostInput(value);
      const selected = this.selection;
      this.assertCurrent(root, generation);
      if (!selected || selected.id !== input.selectionId || selected.root !== root)
        throw new ViewError(
          'local_post_selection',
          '선택한 파일을 사용할 수 없습니다. 저장 여부를 확인한 뒤 파일을 다시 선택하세요.',
        );
      const chosen = input.mediaIds.map((id) => selected.files.find((file) => file.id === id));
      if (chosen.some((file) => !file))
        throw new ViewError('local_post_selection', '선택 목록에 없는 파일은 등록할 수 없습니다.');
      const recovery = this.recover(root);
      this.job = recovery;
      await recovery.result;
      this.job = null;
      this.assertCurrent(root, generation);
      const before = await this.refresh(root);
      this.assertCurrent(root, generation);
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      if (before.snapshot?.root !== root)
        throw new ViewError('local_post_folder', '설정에서 작업 폴더를 연결한 뒤 작성하세요.');
      const warning = before.snapshot.warnings.find((item) =>
        ['deletion_recovery_required', 'drafts_unavailable', 'local_posts_unavailable'].includes(
          item.code,
        ),
      );
      if (warning) throw new ViewError(warning.code, warning.message);
      // Preserve previews and input on errors. Every retry uses this same stable
      // post ID; the worker checks its committed receipt before doing any new copy.
      const job = this.launch({
        root,
        postId: selected.id,
        caption: input.caption,
        files: chosen.map((file) => ({
          path: file!.path,
          mediaId: file!.id,
          kind: file!.kind,
          size: file!.file.size,
          sha256: file!.file.sha256,
        })),
      });
      attempted = true;
      this.job = job;
      const saved = await job.result;
      committed = selected;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { snapshot: before.snapshot, error: null };
      }
      const post =
        view.snapshot?.root === root
          ? view.snapshot.posts.find((post) => post.key === saved.postKey)
          : undefined;
      if (
        view.error ||
        !post?.draft ||
        post.draft.revision < saved.draft.revision ||
        (post.draft.revision === saved.draft.revision &&
          (post.draft.caption !== saved.draft.caption ||
            JSON.stringify(post.draft.mediaIds) !== JSON.stringify(saved.draft.mediaIds)))
      ) {
        view = {
          snapshot: view.snapshot?.root === root ? view.snapshot : before.snapshot,
          error: {
            code: 'local_post_refresh_failed',
            message:
              '직접 작성한 글은 등록됐지만 목록을 갱신하지 못했습니다. 다시 등록하지 말고 새로고침하세요.',
          },
        };
      }
      return { status: 'saved', postKey: saved.postKey, view };
    } catch (error) {
      if (attempted) {
        try {
          await this.refresh(root);
        } catch {
          /* Keep the original result. */
        }
      }
      return failure(error);
    } finally {
      if (committed) {
        if (this.selection === committed) this.selection = null;
        await removeSelection(committed).catch(() => {});
      }
    }
  }
  async respond(request: Request): Promise<Response> {
    if (!/^threads-import:\/\/file\/[a-f0-9]{32}$/.test(request.url) || !this.selection)
      return new Response(null, { status: 404 });
    return this.selection.registry.respond(
      new Request(request.url.replace('threads-import:', 'threads-media:'), {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      }),
    );
  }
  async discard(selectionId: unknown): Promise<void> {
    if (this.creating || typeof selectionId !== 'string' || this.selection?.id !== selectionId)
      return;
    const selection = this.selection;
    if (this.active) {
      ++this.generation;
      this.abort?.abort();
      this.job?.cancel();
      if (!this.choosing) await this.pending;
    }
    if (this.selection !== selection) return;
    this.selection = null;
    await removeSelection(selection);
  }
  async shutdown(): Promise<void> {
    ++this.generation;
    this.abort?.abort();
    this.job?.cancel();
    // The native picker must be allowed to close with its owner window.
    if (!this.choosing) await this.pending;
    const selection = this.selection;
    this.selection = null;
    if (selection) await removeSelection(selection).catch(() => {});
  }
}
