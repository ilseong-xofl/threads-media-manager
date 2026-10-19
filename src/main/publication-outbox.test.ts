import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupPublicationOutbox, publicationWorkDirectory } from './publication-outbox';

describe('owned publication outbox cleanup', () => {
  it('clears marked crash leftovers but preserves unmarked folders, symlink targets and library files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmm-outbox-test-'));
    try {
      const id = randomUUID();
      const work = await publicationWorkDirectory(root, id);
      await writeFile(join(work, '1.png'), 'temporary');
      const unknown = join(root, 'mobile-outbox', randomUUID());
      await mkdir(unknown);
      await writeFile(join(unknown, 'keep'), 'user');
      const original = join(root, 'originals');
      await mkdir(original);
      await writeFile(join(original, 'keep'), 'original');
      await symlink(original, join(root, 'mobile-outbox', randomUUID()), 'dir');
      await cleanupPublicationOutbox(root);
      await expect(readFile(join(work, '1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(unknown, 'keep'), 'utf8')).toBe('user');
      expect(await readFile(join(original, 'keep'), 'utf8')).toBe('original');
      await publicationWorkDirectory(root, id);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('replaces only its own marked retry directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tmm-outbox-test-'));
    try {
      const id = randomUUID();
      const work = await publicationWorkDirectory(root, id);
      await writeFile(join(work, '1.png'), 'leftover');
      await publicationWorkDirectory(root, id);
      await expect(readFile(join(work, '1.png'))).rejects.toMatchObject({ code: 'ENOENT' });
      const unownedId = randomUUID();
      await mkdir(join(root, 'mobile-outbox', unownedId));
      await expect(publicationWorkDirectory(root, unownedId)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
