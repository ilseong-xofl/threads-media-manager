import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { ViewError } from './collection';
import { validThreadsHistory, type ThreadsHistory } from './threads-publishing';

const FILE = 'publication-transfer.json';
const LIMIT = 10 * 1024 * 1024;
const failed = () =>
  new ViewError(
    'library_publications',
    '컴퓨터 이전용 게시 이력을 확인하지 못했습니다. 기존 자료를 보존하고 DB 백업·복원을 다시 확인하세요.',
  );
const missing = (error: unknown) =>
  !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';

async function readJson(path: string, limit: number): Promise<unknown> {
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw failed();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (info.dev !== before.dev || info.ino !== before.ino || info.size !== before.size)
      throw failed();
    const raw = await file.readFile();
    const after = await file.stat();
    if (raw.length > limit || after.size !== info.size || after.mtimeMs !== info.mtimeMs)
      throw failed();
    return JSON.parse(raw.toString('utf8'));
  } finally {
    await file.close();
  }
}

async function transferPath(root: string, libraryId: string, allowMissingState = false) {
  if (!/^[a-f0-9]{32}$/.test(libraryId)) throw failed();
  const base = await realpath(root);
  const media = await lstat(join(base, 'media'));
  if (!media.isDirectory() || media.isSymbolicLink()) throw failed();
  const marker = (await readJson(join(base, 'media', '.library.json'), 4096)) as Record<
    string,
    unknown
  >;
  if (!marker || marker.schema_version !== 1 || marker.library_id !== libraryId) throw failed();
  try {
    const state = await lstat(join(base, 'state'));
    if (!state.isDirectory() || state.isSymbolicLink()) throw failed();
  } catch (error) {
    if (allowMissingState && missing(error)) return null;
    throw error;
  }
  return join(base, 'state', FILE);
}

/** Portable publication records only. OS-encrypted credentials stay on each PC. */
export async function saveLibraryPublications(
  root: string,
  libraryId: string,
  history: ThreadsHistory,
) {
  let temporary: string | undefined;
  try {
    if (
      !validThreadsHistory(history) ||
      history.records.some((item) => item.libraryId !== libraryId)
    )
      throw failed();
    const path = await transferPath(root, libraryId);
    if (!path) throw failed();
    const raw = JSON.stringify({ version: 1, libraryId, history }) + '\n';
    if (Buffer.byteLength(raw) > LIMIT) throw failed();
    temporary = path + '.' + randomUUID() + '.tmp';
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(raw, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch {
    throw failed();
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
  }
}

export async function readLibraryPublications(
  root: string,
  libraryId: string,
): Promise<ThreadsHistory | null> {
  try {
    const path = await transferPath(root, libraryId, true);
    if (!path) return null;
    let value: unknown;
    try {
      value = await readJson(path, LIMIT);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    const copy = value as Record<string, unknown>;
    if (
      !copy ||
      copy.version !== 1 ||
      copy.libraryId !== libraryId ||
      !validThreadsHistory(copy.history) ||
      copy.history.records.some((item) => item.libraryId !== libraryId)
    )
      throw failed();
    return copy.history;
  } catch {
    throw failed();
  }
}
