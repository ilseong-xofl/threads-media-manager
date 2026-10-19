import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../shared/contracts';
import { mobilePublicationBlocks } from './publication-work-gate';

describe('publication and local mutation barrier', () => {
  it('allows simultaneous account/history reads but blocks account mutations, file edits and restores', () => {
    for (const read of [IPC.mobilePublications, IPC.managedThreadsAccounts, IPC.current])
      expect(mobilePublicationBlocks(read, true)).toBe(false);
    for (const mutation of [
      IPC.deleteManagedThreadsAccount,
      IPC.replaceManagedThreadsToken,
      IPC.saveMediaEdit,
      IPC.deleteMedia,
      IPC.restoreDatabase,
      IPC.deletePostDraft,
    ])
      expect(mobilePublicationBlocks(mutation, true)).toBe(true);
  });
  it.each([IPC.saveMediaEdit, IPC.deleteMedia, IPC.restoreDatabase])(
    'rechecks %s after a shared initialization barrier',
    async (channel) => {
      let active = false;
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = (async () => {
        if (mobilePublicationBlocks(channel, active)) return false;
        await barrier;
        return !mobilePublicationBlocks(channel, active);
      })();
      active = true;
      release();
      expect(await admitted).toBe(false);
      const main = await readFile(join(process.cwd(), 'src/main/index.ts'), 'utf8');
      expect(
        main.match(/mobilePublicationBlocks\(channel, mobilePublications.active\)/g),
      ).toHaveLength(2);
      expect(main.indexOf('await initializeLibrary();')).toBeGreaterThan(
        main.indexOf('mobilePublicationBlocks(channel, mobilePublications.active)'),
      );
      expect(
        main.lastIndexOf('mobilePublicationBlocks(channel, mobilePublications.active)'),
      ).toBeGreaterThan(main.indexOf('await initializeLibrary();'));
      expect(main).toContain('managedAccountMutations > 0');
    },
  );
});
