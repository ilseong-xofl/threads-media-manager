import { execFile, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionView } from '../shared/contracts';
import { ViewError } from './collection';
import {
  LibraryMaintenanceController,
  launchLibraryMaintenance,
  maintenanceBackupFileName,
  parseMaintenanceResult,
  type LaunchMaintenance,
  type MaintenanceCommand,
  type MaintenanceDialogs,
  type MaintenanceReceipt,
} from './library-maintenance';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));
vi.mock('./python', () => ({ pythonCommand: () => ({ command: 'python', prefix: ['-3'] }) }));

const root = '/collection';
const backupPath = '/backups/library.sqlite';
const safety = `${root}/state/backups/before-restore-${'b'.repeat(32)}.sqlite`;
const library = 'a'.repeat(32);
const backup: MaintenanceCommand = { command: 'backup', root, path: backupPath };
const restore: MaintenanceCommand = { command: 'restore', root, path: backupPath };
const reconnect: MaintenanceCommand = { command: 'reconnect', root };
const view: CollectionView = {
  snapshot: {
    root,
    loadedAt: '2026-09-22T01:00:00+00:00',
    sourceCount: 0,
    posts: [],
    warnings: [],
    stateStatus: 'read_only',
  },
  error: null,
};
const rawReceipt = (input: MaintenanceCommand, extra = {}) =>
  JSON.stringify({
    ok: true,
    operation: input.command,
    library_id: library,
    ...(input.command === 'backup' ? { file_path: input.path } : {}),
    ...(input.command === 'restore'
      ? { automatic_backup_path: safety, restore_mode: 'metadata', history_review_required: false }
      : {}),
    ...extra,
  });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};
function setup() {
  const refresh = vi.fn().mockResolvedValue(view);
  const dialogs = {
    chooseBackup: vi.fn().mockResolvedValue(backupPath),
    chooseRestore: vi.fn().mockResolvedValue(backupPath),
    confirmRestore: vi.fn().mockResolvedValue(true),
    chooseReconnect: vi.fn().mockResolvedValue(root),
  } satisfies MaintenanceDialogs;
  const cancel = vi.fn();
  const launch = vi.fn<LaunchMaintenance>((input) => ({
    result: Promise.resolve(parseMaintenanceResult(rawReceipt(input), input)),
    cancel,
  }));
  const busy = vi.fn(() => false);
  const controller = new LibraryMaintenanceController(refresh, dialogs, launch, busy);
  return { refresh, dialogs, cancel, launch, busy, controller };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('maintenance worker receipts', () => {
  it('accepts only the requested operation and expected backup path', () => {
    expect(parseMaintenanceResult(rawReceipt(backup), backup)).toEqual({
      operation: 'backup',
      libraryId: library,
      filePath: backupPath,
    });
    expect(parseMaintenanceResult(rawReceipt(reconnect), reconnect)).toEqual({
      operation: 'reconnect',
      libraryId: library,
    });
    for (const patch of [
      { operation: 'restore' },
      { library_id: '' },
      { file_path: '/other.sqlite' },
    ])
      expect(() => parseMaintenanceResult(rawReceipt(backup, patch), backup)).toThrow(ViewError);
  });
  it('requires a safety backup and no history review for normal metadata restoration', () => {
    expect(parseMaintenanceResult(rawReceipt(restore), restore)).toMatchObject({
      automaticBackupPath: safety,
      restoreMode: 'metadata',
      historyReviewRequired: false,
    });
    for (const patch of [
      { automatic_backup_path: undefined },
      { automatic_backup_path: '/outside/before-restore.sqlite' },
      { automatic_backup_path: `${root}/state/backups/../../../other.sqlite` },
      { restore_mode: 'all' },
      { history_review_required: true },
    ])
      expect(() => parseMaintenanceResult(rawReceipt(restore, patch), restore)).toThrow(ViewError);
  });
  it('allows an explicit absent library ID only when connecting a fresh folder', () => {
    expect(parseMaintenanceResult(rawReceipt(reconnect, { library_id: null }), reconnect)).toEqual({
      operation: 'reconnect',
      libraryId: null,
    });
    for (const input of [backup, restore])
      expect(() => parseMaintenanceResult(rawReceipt(input, { library_id: null }), input)).toThrow(
        ViewError,
      );
    expect(() =>
      parseMaintenanceResult(rawReceipt(reconnect, { library_id: undefined }), reconnect),
    ).toThrow(ViewError);
  });
  it('accepts missing-current-DB full restore only with the history-review flag', () => {
    expect(
      parseMaintenanceResult(
        rawReceipt(restore, {
          restore_mode: 'full',
          history_review_required: true,
          automatic_backup_path: undefined,
        }),
        restore,
      ),
    ).toMatchObject({ restoreMode: 'full', historyReviewRequired: true });
    expect(() =>
      parseMaintenanceResult(
        rawReceipt(restore, {
          restore_mode: 'full',
          history_review_required: false,
        }),
        restore,
      ),
    ).toThrow(ViewError);
  });
  it('preserves a bounded public worker error and hides malformed diagnostics', () => {
    expect(() =>
      parseMaintenanceResult(
        JSON.stringify({
          ok: false,
          code: 'library_mismatch',
          message: '같은 라이브러리의 백업을 선택하세요.',
        }),
        restore,
      ),
    ).toThrow('같은 라이브러리');
    for (const raw of [
      'private stderr',
      'null',
      '[]',
      '{',
      JSON.stringify({ ok: false, code: 'bad/path', message: 'secret' }),
    ]) {
      expect(() => parseMaintenanceResult(raw, restore)).toThrow('유지관리 결과');
    }
  });
});

describe('native maintenance flow', () => {
  it('backs up through the native file choice and never passes a renderer file path', async () => {
    const { controller, dialogs, launch, refresh } = setup();
    expect(await controller.backup(root)).toEqual({
      status: 'complete',
      operation: 'backup',
      filePath: backupPath,
      view,
    });
    expect(dialogs.chooseBackup).toHaveBeenCalledWith(
      expect.stringMatching(/^threads-media-manager-backup-.*\.sqlite$/),
      expect.any(AbortSignal),
    );
    expect(launch).toHaveBeenCalledExactlyOnceWith(backup);
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
    expect(controller.active).toBe(false);
  });
  it('requires both native restore choice and explicit confirmation before launch', async () => {
    const { controller, dialogs, launch } = setup();
    expect(await controller.restore(root)).toMatchObject({
      status: 'complete',
      operation: 'restore',
      automaticBackupPath: safety,
      restoreMode: 'metadata',
      historyReviewRequired: false,
      view,
    });
    expect(dialogs.confirmRestore).toHaveBeenCalledExactlyOnceWith(
      backupPath,
      expect.any(AbortSignal),
    );
    expect(launch).toHaveBeenCalledExactlyOnceWith(restore);
  });
  it('allows the worker to validate a broken or moved root without requiring a readable snapshot first', async () => {
    const { controller, refresh, launch } = setup();
    refresh.mockImplementation(async () => {
      expect(launch).toHaveBeenCalledOnce();
      return view;
    });
    expect(await controller.reconnect(root)).toMatchObject({
      status: 'complete',
      operation: 'reconnect',
    });
    expect(launch).toHaveBeenCalledExactlyOnceWith(reconnect);
  });
  it.each([null, root])(
    'selects and refreshes a new folder from current root %j',
    async (current) => {
      const { controller, dialogs, refresh, launch } = setup();
      const selected = '/moved-collection';
      const selectedView = { ...view, snapshot: { ...view.snapshot!, root: selected } };
      dialogs.chooseReconnect.mockResolvedValue(selected);
      refresh.mockResolvedValue(selectedView);
      expect(await controller.reconnect(current)).toMatchObject({
        status: 'complete',
        operation: 'reconnect',
        view: selectedView,
      });
      expect(dialogs.chooseReconnect).toHaveBeenCalledExactlyOnceWith(
        current,
        expect.any(AbortSignal),
      );
      expect(launch).toHaveBeenCalledExactlyOnceWith({ command: 'reconnect', root: selected });
      expect(refresh).toHaveBeenCalledExactlyOnceWith(selected);
    },
  );
  it('preserves the existing root when a selected reconnect folder fails validation', async () => {
    const { controller, dialogs, refresh, launch, cancel } = setup();
    dialogs.chooseReconnect.mockResolvedValue('/wrong-collection');
    launch.mockReturnValue({
      result: Promise.reject(new ViewError('library_mismatch', '자료 식별 정보를 확인하세요.')),
      cancel,
    });
    expect(await controller.reconnect(root)).toMatchObject({
      status: 'error',
      problem: { code: 'library_mismatch' },
    });
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
  });
  it.each(['', 'relative', '/bad\0root'])(
    'rejects invalid folder selection %j',
    async (selected) => {
      const { controller, dialogs, launch, refresh } = setup();
      dialogs.chooseReconnect.mockResolvedValue(selected);
      expect(await controller.reconnect(null)).toMatchObject({
        status: 'error',
        problem: { code: 'maintenance_root' },
      });
      expect(launch).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
  it('reports full disaster restoration and review requirements without inventing a safety-backup path', async () => {
    const { controller, launch, cancel } = setup();
    launch.mockReturnValue({
      result: Promise.resolve({
        operation: 'restore',
        libraryId: library,
        restoreMode: 'full',
        historyReviewRequired: true,
      }),
      cancel,
    });
    expect(await controller.restore(root)).toEqual({
      status: 'complete',
      operation: 'restore',
      restoreMode: 'full',
      historyReviewRequired: true,
      view,
    });
  });
  it.each(['backup', 'restore', 'reconnect'] as const)(
    'cancels %s before any worker or refresh',
    async (operation) => {
      const { controller, dialogs, launch, refresh } = setup();
      dialogs.chooseBackup.mockResolvedValue(null);
      dialogs.chooseRestore.mockResolvedValue(null);
      dialogs.chooseReconnect.mockResolvedValue(null);
      expect(await controller[operation](root)).toEqual({ status: 'cancelled' });
      expect(launch).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
    },
  );
  it('does not restore when confirmation is declined', async () => {
    const { controller, dialogs, launch } = setup();
    dialogs.confirmRestore.mockResolvedValue(false);
    expect(await controller.restore(root)).toEqual({ status: 'cancelled' });
    expect(launch).not.toHaveBeenCalled();
  });
  it.each([null, '', 'relative', '/bad\0root'])(
    'rejects invalid root %j before opening a dialog',
    async (bad) => {
      const { controller, dialogs, launch } = setup();
      expect(await controller.backup(bad)).toMatchObject({
        status: 'error',
        problem: { code: 'maintenance_root' },
      });
      expect(dialogs.chooseBackup).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );
  it.each(['relative.sqlite', '/backup.json', '/bad\0.sqlite'])(
    'rejects invalid native selection %j',
    async (bad) => {
      const { controller, dialogs, launch } = setup();
      dialogs.chooseRestore.mockResolvedValue(bad);
      expect(await controller.restore(root)).toMatchObject({
        status: 'error',
        problem: { code: 'maintenance_path' },
      });
      expect(dialogs.confirmRestore).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
    },
  );
  it('guards the complete native-dialog and worker lifetime against concurrent operations', async () => {
    const { controller, dialogs, launch, busy } = setup();
    busy.mockReturnValue(true);
    expect(await controller.restore(root)).toMatchObject({
      status: 'error',
      problem: { code: 'maintenance_busy' },
    });
    busy.mockReturnValue(false);
    const choice = deferred<string | null>();
    dialogs.chooseBackup.mockReturnValue(choice.promise);
    const first = controller.backup(root);
    expect(controller.running).toBe(true);
    expect(await controller.reconnect(root)).toMatchObject({
      status: 'error',
      problem: { code: 'maintenance_busy' },
    });
    choice.resolve(null);
    await first;
    expect(controller.running).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
  it('rechecks external operation guards after a native confirmation', async () => {
    const { controller, dialogs, launch, busy } = setup();
    dialogs.chooseReconnect.mockImplementation(async () => {
      busy.mockReturnValue(true);
      return root;
    });
    expect(await controller.reconnect(root)).toMatchObject({
      status: 'error',
      problem: { code: 'maintenance_busy' },
    });
    expect(launch).not.toHaveBeenCalled();
  });
  it('closes during a pending native dialog without later launching a worker', async () => {
    const { controller, dialogs, launch } = setup();
    const choice = deferred<string | null>();
    dialogs.chooseBackup.mockReturnValue(choice.promise);
    const result = controller.backup(root);
    await flush();
    const signal = dialogs.chooseBackup.mock.calls[0][1];
    await controller.shutdown();
    expect(signal.aborted).toBe(true);
    expect(await result).toEqual({ status: 'cancelled' });
    choice.resolve(backupPath);
    await flush();
    expect(launch).not.toHaveBeenCalled();
    dialogs.chooseBackup.mockResolvedValue(backupPath);
    expect(await controller.backup(root)).toMatchObject({ status: 'complete' });
  });
  it('waits for a started transaction and refresh on shutdown without interrupting it', async () => {
    const { controller, launch, refresh, cancel } = setup();
    const job = deferred<MaintenanceReceipt>();
    const refreshed = deferred<CollectionView>();
    launch.mockReturnValue({ result: job.promise, cancel });
    refresh.mockReturnValue(refreshed.promise);
    const result = controller.restore(root);
    await flush();
    let closed = false;
    const closing = controller.shutdown().then(() => {
      closed = true;
    });
    expect(cancel).not.toHaveBeenCalled();
    job.resolve(parseMaintenanceResult(rawReceipt(restore), restore));
    await flush();
    expect(closed).toBe(false);
    expect(controller.active).toBe(true);
    refreshed.resolve(view);
    await closing;
    expect(await result).toMatchObject({ status: 'complete', operation: 'restore' });
    expect(controller.active).toBe(false);
  });
  it('keeps committed success distinguishable from a failed view refresh', async () => {
    const { controller, refresh } = setup();
    refresh.mockRejectedValue(new Error('private disk path'));
    expect(await controller.reconnect(root)).toMatchObject({
      status: 'complete',
      view: {
        snapshot: null,
        error: { code: 'maintenance_refresh_failed' },
      },
    });
  });
  it('refreshes after a worker failure and never forwards raw process exceptions', async () => {
    const { controller, launch, refresh, cancel } = setup();
    launch.mockReturnValue({ result: Promise.reject(new Error('private diagnostic')), cancel });
    const result = await controller.restore(root);
    expect(result).toMatchObject({ status: 'error', problem: { code: 'maintenance_failed' } });
    expect(JSON.stringify(result)).not.toContain('private diagnostic');
    expect(refresh).toHaveBeenCalledExactlyOnceWith(root);
  });
});

describe('maintenance process adapter', () => {
  function processMock() {
    const stdin = { on: vi.fn(), end: vi.fn() };
    const kill = vi.fn();
    let done!: (error: Error | null, stdout: string, stderr: string) => void;
    vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
      done = args[3] as typeof done;
      return { stdin, kill } as unknown as ChildProcess;
    });
    return {
      stdin,
      kill,
      finish: (raw: string, error: Error | null = null) => done(error, raw, 'secret stderr'),
    };
  }
  it('uses isolated Python argv, stdin JSON, no shell, and bounded output', async () => {
    const process = processMock();
    const job = launchLibraryMaintenance('/app folder')(backup);
    expect(execFile).toHaveBeenCalledWith(
      'python',
      ['-3', '-I', '-B', '/app folder/local-runtime/library_maintenance.py'],
      expect.objectContaining({ shell: false, windowsHide: true, maxBuffer: 65536 }),
      expect.any(Function),
    );
    expect(process.stdin.end).toHaveBeenCalledExactlyOnceWith(JSON.stringify(backup));
    process.finish(rawReceipt(backup));
    expect(await job.result).toMatchObject({ operation: 'backup' });
  });
  it('adds only the trusted app version to worker input and rejects nonzero worker exit', async () => {
    const process = processMock();
    const job = launchLibraryMaintenance('/app', '0.1.0')(backup);
    const outcome = job.result.catch((error: unknown) => error);
    expect(JSON.parse(process.stdin.end.mock.calls[0][0])).toEqual({
      ...backup,
      appVersion: '0.1.0',
    });
    process.finish(rawReceipt(backup), new Error('private subprocess failure'));
    expect(await outcome).toMatchObject({ code: 'maintenance_worker' });
    expect(String(await outcome)).not.toContain('private subprocess');
  });
  it('times out, escalates cleanup, and clears timers only when the process closes', async () => {
    vi.useFakeTimers();
    const process = processMock();
    const job = launchLibraryMaintenance('/app')(reconnect);
    const outcome = job.result.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(40_000);
    expect(process.kill).toHaveBeenLastCalledWith('SIGKILL');
    process.finish('', new Error('private timeout details'));
    expect(await outcome).toMatchObject({ code: 'maintenance_timeout' });
    expect(vi.getTimerCount()).toBe(0);
  });
  it('cleans timers and redacts child startup failures', async () => {
    vi.useFakeTimers();
    const process = processMock();
    const job = launchLibraryMaintenance('/app')(backup);
    const outcome = job.result.catch((error: unknown) => error);
    process.finish('', new Error('ENOENT private python path'));
    expect(await outcome).toMatchObject({ code: 'maintenance_worker' });
    expect(String(await outcome)).not.toContain('private python');
    expect(vi.getTimerCount()).toBe(0);
    job.cancel();
    expect(process.kill).not.toHaveBeenCalled();
  });
  it('uses a filesystem-safe timestamp for default backup names', () => {
    expect(maintenanceBackupFileName(new Date('2026-09-22T04:05:06.007Z'))).toBe(
      'threads-media-manager-backup-2026-09-22T04-05-06-007Z.sqlite',
    );
  });
});
