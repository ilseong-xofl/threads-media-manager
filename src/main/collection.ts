import { execFile } from 'node:child_process';
import { pythonCommand } from './python';
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { CollectionView, Problem, Snapshot } from '../shared/contracts';
import type { LocalFile } from './media';
import { validPostDraft } from '../shared/post-draft';

export interface RuntimeResult {
  snapshot: Snapshot;
  files: LocalFile[];
}
export class ViewError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const string = (v: unknown): v is string => typeof v === 'string';
const nullable = (v: unknown) => v === null || string(v);

function validComment(value: unknown): boolean {
  if (
    !object(value) ||
    !string(value.caption) ||
    !string(value.link) ||
    !string(value.updatedAt) ||
    value.caption.length > 10_000 ||
    value.link.length > 2048 ||
    value.caption !== value.caption.trim() ||
    value.link !== value.link.trim() ||
    !(value.caption || value.link) ||
    [...value.caption].some(
      (char) => (char.charCodeAt(0) < 32 && !'\n\r\t'.includes(char)) || char.charCodeAt(0) === 127,
    ) ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value.updatedAt) ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString().slice(0, 19) !== value.updatedAt.slice(0, 19)
  )
    return false;
  if (!value.link) return true;
  try {
    const link = new URL(value.link);
    return (
      /^https?:\/\//i.test(value.link) &&
      ['http:', 'https:'].includes(link.protocol) &&
      !!link.hostname &&
      !link.username &&
      !link.password &&
      !/^https?:\/\/[^/?#]*@/i.test(value.link) &&
      ![...value.link].some(
        (char) =>
          /\s/.test(char) || char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '\\',
      )
    );
  } catch {
    return false;
  }
}

export function parseRuntimeResult(raw: string, root: string): RuntimeResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ViewError('runtime_response', '원본 읽기 결과를 해석할 수 없습니다.');
  }
  const invalid = () => {
    throw new ViewError('runtime_response', '원본 읽기 결과의 형식이 올바르지 않습니다.');
  };
  if (!object(data)) return invalid();
  if (
    data.ok === false &&
    object(data.error) &&
    string(data.error.code) &&
    string(data.error.message)
  ) {
    throw new ViewError(data.error.code, data.error.message);
  }
  const s = data.snapshot;
  if (
    data.ok !== true ||
    !object(s) ||
    s.root !== root ||
    !string(s.loadedAt) ||
    !Number.isSafeInteger(s.sourceCount) ||
    !['absent', 'read_only', 'unavailable'].includes(String(s.stateStatus)) ||
    !Array.isArray(s.posts) ||
    !Array.isArray(s.warnings) ||
    !Array.isArray(data.files)
  )
    return invalid();
  for (const p of s.posts) {
    if (
      !object(p) ||
      ![
        'key',
        'account',
        'postId',
        'originalUrl',
        'caption',
        'captionStatus',
        'attachmentStatus',
        'runStatus',
        'gapStatus',
        'source',
      ].every((k) => string(p[k])) ||
      !['publishedAt', 'collectedAt', 'observedAt', 'captionObservedAt'].every((k) =>
        nullable(p[k]),
      ) ||
      !Array.isArray(p.reasons) ||
      !p.reasons.every(string) ||
      !Array.isArray(p.attachments) ||
      (p.edits !== undefined && !Array.isArray(p.edits)) ||
      (p.comment !== undefined && !validComment(p.comment)) ||
      (p.draft !== undefined && !validPostDraft(p.draft))
    )
      return invalid();
    const edits = Array.isArray(p.edits) ? p.edits : [];
    for (const a of [...p.attachments, ...edits]) {
      if (
        !object(a) ||
        !Number.isSafeInteger(a.ordinal) ||
        Number(a.ordinal) < 1 ||
        !['image', 'video'].includes(String(a.kind)) ||
        !['not_downloaded', 'saved', 'unavailable', 'review'].includes(String(a.status)) ||
        !string(a.addressStatus) ||
        !nullable(a.observedAt) ||
        !nullable(a.reason) ||
        !nullable(a.mediaId) ||
        !nullable(a.localUrl) ||
        (a.localUrl !== null &&
          (!string(a.mediaId) ||
            a.localUrl !== `threads-media://file/${a.mediaId}` ||
            !/^[a-f0-9]{32}$/.test(a.mediaId)))
      )
        return invalid();
      if (
        (edits.includes(a) &&
          (a.editType === undefined ||
            a.sourceMediaId === undefined ||
            a.createdAt === undefined)) ||
        (a.editType !== undefined &&
          (!['crop', 'capture', 'trim'].includes(String(a.editType)) ||
            a.kind !== (a.editType === 'trim' ? 'video' : 'image'))) ||
        (a.sourceMediaId !== undefined &&
          (!string(a.sourceMediaId) || !/^[a-f0-9]{32}$/.test(a.sourceMediaId))) ||
        (a.createdAt !== undefined &&
          (!string(a.createdAt) ||
            a.createdAt.length > 64 ||
            !/^\d{4}-\d{2}-\d{2}T/.test(a.createdAt) ||
            !Number.isFinite(Date.parse(a.createdAt))))
      )
        return invalid();
    }
  }
  if (!s.warnings.every((w) => object(w) && string(w.code) && string(w.message))) return invalid();
  for (const f of data.files) {
    if (
      !object(f) ||
      !string(f.id) ||
      !/^[a-f0-9]{32}$/.test(f.id) ||
      !string(f.relativePath) ||
      !string(f.sha256) ||
      !/^[a-f0-9]{64}$/.test(f.sha256) ||
      !['image', 'video'].includes(String(f.kind)) ||
      !Number.isSafeInteger(f.size) ||
      Number(f.size) <= 0
    )
      return invalid();
  }
  return { snapshot: s as unknown as Snapshot, files: data.files as LocalFile[] };
}

export async function readRuntime(projectRoot: string, root: string): Promise<RuntimeResult> {
  const { command, prefix } = pythonCommand(projectRoot);
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [
        ...prefix,
        '-I',
        '-B',
        join(projectRoot, 'local-runtime', 'collection_view.py'),
        '--collection-root',
        root,
      ],
      { timeout: 60_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        if (error && !stdout.trim()) {
          reject(
            new ViewError(
              'runtime_unavailable',
              'Python 3.11 이상을 실행할 수 없습니다. 개발 환경의 TMM_PYTHON 설정을 확인하세요.',
            ),
          );
          return;
        }
        try {
          resolve(parseRuntimeResult(stdout, root));
        } catch (error) {
          reject(error);
        }
      },
    );
  });
}

export async function readRootSetting(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ViewError(
      'settings_unavailable',
      '수집 폴더 설정을 읽을 수 없습니다. 폴더를 직접 연결하세요.',
    );
  }
  try {
    const value = JSON.parse(raw);
    if (
      value.schema_version !== 1 ||
      !string(value.collection_root) ||
      !isAbsolute(value.collection_root)
    )
      throw new Error();
    return value.collection_root;
  } catch {
    throw new ViewError(
      'settings_invalid',
      '수집 폴더 설정이 손상되었거나 지원하지 않는 형식입니다. 폴더를 직접 연결하세요.',
    );
  }
}

export async function rememberRoot(userData: string, root: string): Promise<void> {
  await mkdir(userData, { recursive: true });
  const path = join(userData, 'view-settings.json');
  const temporary = path + '.tmp';
  await writeFile(temporary, JSON.stringify({ schema_version: 1, collection_root: root }) + '\n', {
    mode: 0o600,
  });
  await rename(temporary, path);
}

export function problem(error: unknown): Problem {
  return error instanceof ViewError
    ? { code: error.code, message: error.message }
    : { code: 'read_failed', message: '자료를 읽지 못했습니다. 마지막 정상 목록을 유지합니다.' };
}

export class CollectionController {
  view: CollectionView = { snapshot: null, error: null };
  root: string | null = null;
  private pending: Promise<CollectionView> | null = null;
  constructor(
    private load: (root: string) => Promise<RuntimeResult>,
    private adopt: (root: string, files: LocalFile[]) => Promise<void>,
  ) {}
  get loading(): boolean {
    return this.pending !== null;
  }
  refresh(root = this.root): Promise<CollectionView> {
    if (this.pending) return this.pending;
    if (!root) return Promise.resolve(this.view);
    this.root = root;
    this.pending = (async () => {
      try {
        const data = await this.load(root);
        await this.adopt(root, data.files);
        this.view = { snapshot: data.snapshot, error: null };
      } catch (error) {
        this.view = { ...this.view, error: problem(error) };
      }
      return this.view;
    })().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
}
