import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  RELEASE_NOTES_FILE_NAME,
  markReleaseNotesSeen,
  readSeenReleaseNotes,
} from './release-notes-store';

const folders: string[] = [];
const folder = () => {
  const path = mkdtempSync(join(tmpdir(), 'tmm-release-notes-'));
  folders.push(path);
  return path;
};
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});

it('has no record until a version is marked seen, and leaves no temporary file', () => {
  const userData = folder();
  expect(readSeenReleaseNotes(userData)).toBeNull();
  markReleaseNotesSeen(userData, '0.1.17');
  expect(readSeenReleaseNotes(userData)).toBe('0.1.17');
  markReleaseNotesSeen(userData, '0.1.18');
  expect(readSeenReleaseNotes(userData)).toBe('0.1.18');
  expect(readdirSync(userData)).toEqual([RELEASE_NOTES_FILE_NAME]);
});

it('creates the data folder of a new install', () => {
  const userData = join(folder(), 'new-install');
  markReleaseNotesSeen(userData, '0.1.17');
  expect(readSeenReleaseNotes(userData)).toBe('0.1.17');
});

it('counts a damaged record as missing, and the next close replaces it', () => {
  const userData = folder();
  writeFileSync(join(userData, RELEASE_NOTES_FILE_NAME), '{"version":1,"seen":"latest"}');
  expect(readSeenReleaseNotes(userData)).toBeNull();
  writeFileSync(join(userData, RELEASE_NOTES_FILE_NAME), 'not json');
  expect(readSeenReleaseNotes(userData)).toBeNull();
  markReleaseNotesSeen(userData, '0.1.17');
  expect(readSeenReleaseNotes(userData)).toBe('0.1.17');
});

it('refuses a version that is not major.minor.patch', () => {
  const userData = folder();
  expect(() => markReleaseNotesSeen(userData, 'v0.1.17')).toThrow();
  expect(readdirSync(userData)).toEqual([]);
});
