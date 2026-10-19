import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { uuid } from './mobile-publication-data';

const marker = '.tmm-publication-work';
async function baseDirectory(userData: string) {
  await mkdir(userData, { recursive: true, mode: 0o700 });
  const parent = await realpath(userData);
  const base = join(parent, 'mobile-outbox');
  await mkdir(base, { recursive: true, mode: 0o700 });
  if ((await lstat(base)).isSymbolicLink() || (await realpath(base)) !== base)
    throw new Error('Invalid app outbox');
  return base;
}
async function owned(base: string, id: string) {
  if (!uuid(id)) return false;
  const path = join(base, id);
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path) return false;
  try {
    const tag = await lstat(join(path, marker));
    return (
      tag.isFile() &&
      !tag.isSymbolicLink() &&
      tag.nlink === 1 &&
      tag.size < 128 &&
      (await readFile(join(path, marker), 'utf8')) === `tmm-publication-work-v1:${id}\n`
    );
  } catch {
    return false;
  }
}
/** Only marked, UUID-named app copies are eligible; original library files are never traversed. */
export async function cleanupPublicationOutbox(userData: string): Promise<void> {
  const base = await baseDirectory(userData);
  for (const name of await readdir(base))
    if (await owned(base, name)) await rm(join(base, name), { recursive: true, force: true });
}
export async function publicationWorkDirectory(userData: string, id: string): Promise<string> {
  if (!uuid(id)) throw new Error('Invalid publication request');
  const base = await baseDirectory(userData);
  const directory = join(base, id);
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (
      !error ||
      typeof error !== 'object' ||
      !('code' in error) ||
      error.code !== 'EEXIST' ||
      !(await owned(base, id))
    )
      throw error;
    await rm(directory, { recursive: true });
    await mkdir(directory, { mode: 0o700 });
  }
  await writeFile(join(directory, marker), `tmm-publication-work-v1:${id}\n`, {
    flag: 'wx',
    mode: 0o600,
  });
  return directory;
}
