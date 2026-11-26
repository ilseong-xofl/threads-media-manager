import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  RELEASE_NOTES,
  compareVersions,
  releaseNotesToShow,
  validVersion,
  type ReleaseNote,
} from './release-notes';

const packageVersion = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { version: string }
).version;

describe('the notes', () => {
  it('have an entry for the package version, so a release cannot go out without one', () => {
    expect(RELEASE_NOTES.some((note) => note.version === packageVersion)).toBe(true);
  });

  it('list each version once, newest first, with at least one line', () => {
    RELEASE_NOTES.forEach((note, index) => {
      expect(validVersion(note.version)).toBe(true);
      if (index > 0)
        expect(compareVersions(RELEASE_NOTES[index - 1].version, note.version)).toBeGreaterThan(0);
      const lines = [...(note.added ?? []), ...(note.changed ?? []), ...(note.fixed ?? [])];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line).not.toBe('');
        expect(line.trim()).toBe(line);
      }
    });
  });
});

describe('releaseNotesToShow', () => {
  const notes: ReleaseNote[] = [
    { version: '0.1.10', added: ['c'] },
    { version: '0.1.9', added: ['b'] },
    { version: '0.1.8', added: ['a'] },
  ];
  const shown = (current: string, seen: string | null) =>
    releaseNotesToShow(notes, current, seen).map((note) => note.version);

  it('shows the versions after the one last seen, up to the running one', () => {
    expect(shown('0.1.10', '0.1.8')).toEqual(['0.1.10', '0.1.9']);
    // A note written for the next release stays hidden until that release runs.
    expect(shown('0.1.9', '0.1.8')).toEqual(['0.1.9']);
  });

  it('shows nothing once the running version was seen, or after going back a version', () => {
    expect(shown('0.1.10', '0.1.10')).toEqual([]);
    expect(shown('0.1.9', '0.1.10')).toEqual([]);
  });

  it('shows every note up to the running version on a PC without a record', () => {
    expect(shown('0.1.9', null)).toEqual(['0.1.9', '0.1.8']);
  });

  it('compares versions as numbers', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.1.16', '0.1.16')).toBe(0);
    expect(validVersion('v0.1.16')).toBe(false);
    expect(validVersion('0.1')).toBe(false);
  });
});
