import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { formerShortcutPaths, removeFormerShortcuts } from './former-shortcuts';
import { selectVariant } from '../../scripts/variants.mjs';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const former = selectVariant('dev').formerShortcuts;

/** A Windows profile after the renaming update: Squirrel's new shortcuts beside the old ones. */
async function profile() {
  const root = await mkdtemp(join(tmpdir(), 'former-shortcuts-'));
  directories.push(root);
  const desktop = join(root, 'Desktop');
  const appData = join(root, 'AppData', 'Roaming');
  const programs = join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs');
  const files = {
    oldDesktop: join(desktop, 'Threads Media Manager.lnk'),
    oldStartMenu: join(programs, 'Threads Media Manager', 'Threads Media Manager.lnk'),
    newDesktop: join(desktop, '(개발) ILS 소셜(T) 관리.lnk'),
    newStartMenu: join(programs, 'ILS 소셜(T) 관리', '(개발) ILS 소셜(T) 관리.lnk'),
    prodStartMenu: join(programs, 'ILS 소셜(T) 관리', 'ILS 소셜(T) 관리.lnk'),
    otherDesktop: join(desktop, 'Threads Media Manager.txt'),
  };
  for (const file of Object.values(files)) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'shortcut');
  }
  const getPath = (name: 'desktop' | 'appData') => (name === 'desktop' ? desktop : appData);
  return { files, getPath, oldFolder: dirname(files.oldStartMenu) };
}

it('finds the shortcuts where Squirrel put them for the former names', () => {
  expect(former).toEqual([
    { companyName: 'Threads Media Manager', productName: 'Threads Media Manager' },
  ]);
  const folder = join(
    'appData',
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Threads Media Manager',
  );
  expect(formerShortcutPaths(former[0], 'desktop', 'appData')).toEqual({
    desktop: join('desktop', 'Threads Media Manager.lnk'),
    startMenu: join(folder, 'Threads Media Manager.lnk'),
    startMenuFolder: folder,
  });
});

it.each(['--squirrel-install', '--squirrel-updated'])(
  'removes only the former shortcuts and their emptied folder on %s',
  async (command) => {
    const { files, getPath, oldFolder } = await profile();
    removeFormerShortcuts(command, former, getPath);
    expect(existsSync(files.oldDesktop)).toBe(false);
    expect(existsSync(files.oldStartMenu)).toBe(false);
    expect(existsSync(oldFolder)).toBe(false);
    for (const kept of ['newDesktop', 'newStartMenu', 'prodStartMenu', 'otherDesktop'] as const)
      expect(existsSync(files[kept])).toBe(true);
  },
);

it('keeps the former Start menu folder while something else is in it', async () => {
  const { files, getPath, oldFolder } = await profile();
  const other = join(oldFolder, 'Uninstall.lnk');
  await writeFile(other, 'shortcut');
  removeFormerShortcuts('--squirrel-updated', former, getPath);
  expect(existsSync(files.oldStartMenu)).toBe(false);
  expect(existsSync(other)).toBe(true);
});

it.each([undefined, '--squirrel-firstrun', '--squirrel-uninstall', '--squirrel-obsolete', '.'])(
  'leaves every shortcut alone when started with %j',
  async (command) => {
    const { files, getPath } = await profile();
    removeFormerShortcuts(command, former, getPath);
    for (const file of Object.values(files)) expect(existsSync(file)).toBe(true);
  },
);

it('never fails the install or update', async () => {
  const { files, getPath } = await profile();
  // The desktop shortcut cannot be removed; the Start menu one still is.
  await rm(files.oldDesktop);
  await mkdir(join(files.oldDesktop, 'kept'), { recursive: true });
  expect(() => removeFormerShortcuts('--squirrel-updated', former, getPath)).not.toThrow();
  expect(existsSync(join(files.oldDesktop, 'kept'))).toBe(true);
  expect(existsSync(files.oldStartMenu)).toBe(false);
  // Already clean.
  expect(() => removeFormerShortcuts('--squirrel-updated', former, getPath)).not.toThrow();
  expect(() =>
    removeFormerShortcuts('--squirrel-updated', former, () => {
      throw new Error("Failed to get 'desktop' path");
    }),
  ).not.toThrow();
});
