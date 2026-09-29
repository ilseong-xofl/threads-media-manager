import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLibraryPublications, saveLibraryPublications } from './library-publications';
import type { ThreadsHistory } from './threads-publishing';

const roots: string[] = [];
const library = 'a'.repeat(32);
const history: ThreadsHistory = { version: 1, records: [], sync: {} };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'library-transfer-'));
  roots.push(root);
  await mkdir(join(root, 'media'));
  await mkdir(join(root, 'state'));
  await writeFile(
    join(root, 'media', '.library.json'),
    JSON.stringify({ schema_version: 1, library_id: library }),
  );
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it('reads the portable history from a copied folder at a different path', async () => {
  const root = await fixture();
  await saveLibraryPublications(root, library, history);
  const destination = await fixture();
  await cp(join(root, 'state'), join(destination, 'state'), { recursive: true });
  expect(await readLibraryPublications(destination, library)).toEqual(history);
});
it('keeps older libraries without a transfer file usable', async () => {
  expect(await readLibraryPublications(await fixture(), library)).toBeNull();
});
it('allows selecting copied media before the DB state directory has been restored', async () => {
  const root = await fixture();
  await rm(join(root, 'state'), { recursive: true });
  expect(await readLibraryPublications(root, library)).toBeNull();
});
it('rejects wrong-library or malformed history without replacing the file', async () => {
  const root = await fixture();
  await saveLibraryPublications(root, library, history);
  const file = join(root, 'state', 'publication-transfer.json');
  const before = await readFile(file);
  await expect(saveLibraryPublications(root, 'b'.repeat(32), history)).rejects.toMatchObject({
    code: 'library_publications',
  });
  expect(await readFile(file)).toEqual(before);
  await writeFile(file, '{bad');
  await expect(readLibraryPublications(root, library)).rejects.toMatchObject({
    code: 'library_publications',
  });
  expect(await readFile(file, 'utf8')).toBe('{bad');
});
it('rejects a symbolic-link history file', async () => {
  const root = await fixture();
  const other = await fixture();
  await saveLibraryPublications(other, library, history);
  await symlink(
    join(other, 'state', 'publication-transfer.json'),
    join(root, 'state', 'publication-transfer.json'),
  );
  await expect(readLibraryPublications(root, library)).rejects.toMatchObject({
    code: 'library_publications',
  });
});
