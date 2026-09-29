import { describe, expect, it, vi } from 'vitest';
import { createUpdateBlockReporter, updateBlockedByUi, type UpdateUiState } from './update-blocker';

const idle: UpdateUiState = {
  busy: false,
  downloading: false,
  exporting: null,
  localMutation: false,
  selected: null,
  registration: null,
  settingsOpen: false,
  contentPostKey: null,
  confirmDownload: false,
};
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe('update restart protection', () => {
  it.each([
    ['initial load', { busy: true }],
    ['download or wait between files', { downloading: true }],
    ['ZIP export', { exporting: 'post:1' }],
    ['save, caption generation, maintenance or Threads work', { localMutation: true }],
    ['detail and nested image/video editor', { selected: 'post:1' }],
    ['unsaved registration or comment', { registration: { postKey: 'post:1', mode: 'edit' } }],
    ['settings including connection input', { settingsOpen: true }],
    ['AI draft dialog', { contentPostKey: 'post:1' }],
    ['download confirmation before its worker exists', { confirmDownload: true }],
  ])('blocks during %s even while every main worker could still be idle', (_name, change) => {
    expect(updateBlockedByUi({ ...idle, ...change })).toBe(true);
  });
  it('only releases the block after both an open editor and its save have finished', () => {
    const editing = { ...idle, registration: { postKey: 'post:1' }, localMutation: true };
    expect(updateBlockedByUi(editing)).toBe(true);
    expect(updateBlockedByUi({ ...editing, registration: null })).toBe(true);
    expect(updateBlockedByUi({ ...editing, localMutation: false })).toBe(true);
    expect(updateBlockedByUi(idle)).toBe(false);
  });
  it('reports a new block immediately without waiting for an older idle acknowledgement', async () => {
    const older = deferred();
    const send = vi
      .fn<(value: boolean) => Promise<void>>()
      .mockReturnValueOnce(older.promise)
      .mockResolvedValue(undefined);
    const reporter = createUpdateBlockReporter(send);
    reporter.report(false);
    reporter.report(true);
    reporter.report(true);
    expect(send.mock.calls).toEqual([[false], [true]]);
    older.resolve();
    await older.promise;
    expect(send.mock.calls).toEqual([[false], [true]]);
  });
  it('restores a block on reporting failure and never sends idle again for that renderer', async () => {
    const failed = deferred();
    const send = vi
      .fn<(value: boolean) => Promise<void>>()
      .mockReturnValueOnce(failed.promise)
      .mockResolvedValue(undefined);
    const reporter = createUpdateBlockReporter(send);
    reporter.report(true);
    failed.reject(new Error('IPC failed'));
    await Promise.resolve();
    reporter.report(false);
    reporter.report(true);
    reporter.report(false);
    expect(send.mock.calls).toEqual([[true], [true]]);
  });
  it('handles a synchronous missing bridge as a failure instead of silently permitting restart', () => {
    const send = vi.fn<(value: boolean) => Promise<void>>().mockImplementation(() => {
      throw new Error('bridge missing');
    });
    const reporter = createUpdateBlockReporter(send);
    expect(() => reporter.report(true)).not.toThrow();
    reporter.report(false);
    expect(send.mock.calls).toEqual([[true], [true]]);
  });
  it('blocks when the view unmounts and cannot send a late idle report afterwards', () => {
    const send = vi.fn<(value: boolean) => Promise<void>>().mockResolvedValue(undefined);
    const reporter = createUpdateBlockReporter(send);
    reporter.report(false);
    reporter.dispose();
    reporter.dispose();
    reporter.report(false);
    expect(send.mock.calls).toEqual([[false], [true]]);
  });
});
