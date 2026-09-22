import { execFile } from 'node:child_process';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type {
  CollectionView,
  LibraryMaintenanceOperation,
  LibraryMaintenanceResult,
} from '../shared/contracts';
import { ViewError } from './collection';
import { pythonCommand } from './python';

export type MaintenanceCommand =
  | { command: 'backup' | 'restore'; root: string; path: string }
  | { command: 'reconnect'; root: string };
export interface MaintenanceReceipt {
  operation: LibraryMaintenanceOperation;
  libraryId: string | null;
  filePath?: string;
  automaticBackupPath?: string;
  restoreMode?: 'metadata' | 'full';
  historyReviewRequired?: boolean;
}
export type LaunchMaintenance = (input: MaintenanceCommand) => {
  result: Promise<MaintenanceReceipt>;
  cancel(): void;
};
export interface MaintenanceDialogs {
  chooseBackup(fileName: string, signal: AbortSignal): Promise<string | null>;
  chooseRestore(signal: AbortSignal): Promise<string | null>;
  confirmRestore(sourcePath: string, signal: AbortSignal): Promise<boolean>;
  chooseReconnect(currentRoot: string | null, signal: AbortSignal): Promise<string | null>;
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const pathValue = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 32768 && !value.includes('\0') && isAbsolute(value);
const matchingPath = (left: string, right: string) =>
  process.platform === 'win32'
    ? resolve(left).toLowerCase() === resolve(right).toLowerCase()
    : resolve(left) === resolve(right);

export function maintenanceBackupFileName(now = new Date()): string {
  return `threads-media-manager-backup-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`;
}

export function parseMaintenanceResult(raw: string, input: MaintenanceCommand): MaintenanceReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Only the bounded worker receipt is accepted. */
  }
  const invalid = () => {
    throw new ViewError(
      'maintenance_response',
      '유지관리 결과를 확인하지 못했습니다. 다시 실행하기 전에 저장 상태를 확인하세요.',
    );
  };
  if (!object(value)) return invalid();
  if (
    value.ok === false &&
    typeof value.code === 'string' &&
    /^[a-z_]{1,64}$/.test(value.code) &&
    typeof value.message === 'string' &&
    value.message.length > 0 &&
    value.message.length <= 2000
  )
    throw new ViewError(value.code, value.message);
  if (
    value.ok !== true ||
    value.operation !== input.command ||
    !(
      (typeof value.library_id === 'string' && /^[a-f0-9]{32}$/.test(value.library_id)) ||
      (input.command === 'reconnect' && value.library_id === null)
    )
  )
    return invalid();
  const receipt: MaintenanceReceipt = {
    operation: input.command,
    libraryId: value.library_id as string | null,
  };
  if (input.command === 'backup') {
    if (!pathValue(value.file_path) || !matchingPath(value.file_path, input.path)) return invalid();
    receipt.filePath = input.path;
  }
  if (input.command === 'restore') {
    if (
      !['metadata', 'full'].includes(String(value.restore_mode)) ||
      value.history_review_required !== (value.restore_mode === 'full')
    )
      return invalid();
    receipt.restoreMode = value.restore_mode as 'metadata' | 'full';
    receipt.historyReviewRequired = value.history_review_required;
    if (value.automatic_backup_path !== undefined) {
      if (!pathValue(value.automatic_backup_path)) return invalid();
      const rel = relative(input.root, value.automatic_backup_path).split(sep).join('/');
      if (!/^state\/backups\/before-restore-[a-f0-9]{32}\.sqlite$/.test(rel)) return invalid();
      receipt.automaticBackupPath = value.automatic_backup_path;
    } else if (value.restore_mode === 'metadata') return invalid();
  }
  return receipt;
}

export function launchLibraryMaintenance(
  projectRoot: string,
  appVersion?: string,
): LaunchMaintenance {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<MaintenanceReceipt>((resolveResult, reject) => {
      let closed = false;
      let stopping = false;
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'library_maintenance.py')],
        { shell: false, windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 },
        (error, stdout) => {
          closed = true;
          clearTimeout(watchdog);
          clearTimeout(killTimer);
          try {
            if (!stdout.trim())
              throw new ViewError(
                'maintenance_worker',
                '유지관리 실행 결과를 확인하지 못했습니다. Python 환경과 저장 공간을 확인하세요.',
              );
            const receipt = parseMaintenanceResult(stdout, input);
            if (error)
              throw new ViewError(
                'maintenance_worker',
                '유지관리 실행이 정상 종료되지 않았습니다. 저장 상태를 확인하세요.',
              );
            resolveResult(receipt);
          } catch (cause) {
            reject(
              timedOut
                ? new ViewError(
                    'maintenance_timeout',
                    '유지관리 시간이 초과됐습니다. 다시 실행하기 전에 저장 상태를 확인하세요.',
                  )
                : cause,
            );
          }
        },
      );
      cancel = () => {
        if (closed || stopping) return;
        stopping = true;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 40_000);
      };
      const watchdog = setTimeout(() => {
        timedOut = true;
        cancel();
      }, 600_000);
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify({ ...input, ...(appVersion ? { appVersion } : {}) }));
    });
    return { result, cancel: () => cancel() };
  };
}

export class LibraryMaintenanceController {
  private pending: Promise<LibraryMaintenanceResult> | null = null;
  private job: ReturnType<LaunchMaintenance> | null = null;
  private dialog: AbortController | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private dialogs: MaintenanceDialogs,
    private launch: LaunchMaintenance,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  get running(): boolean {
    return this.active;
  }
  backup(root: string | null): Promise<LibraryMaintenanceResult> {
    return this.start(root, 'backup');
  }
  restore(root: string | null): Promise<LibraryMaintenanceResult> {
    return this.start(root, 'restore');
  }
  reconnect(root: string | null): Promise<LibraryMaintenanceResult> {
    return this.start(root, 'reconnect');
  }
  private start(
    root: string | null,
    operation: LibraryMaintenanceOperation,
  ): Promise<LibraryMaintenanceResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: { code: 'maintenance_busy', message: '진행 중인 작업이 끝난 뒤 실행하세요.' },
      });
    this.cancelled = false;
    this.pending = this.run(root, operation).finally(() => {
      this.pending = null;
      this.job = null;
      this.dialog = null;
    });
    return this.pending;
  }
  private async ask<T>(callback: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.cancelled) throw new ViewError('cancelled', '유지관리를 취소했습니다.');
    const controller = new AbortController();
    this.dialog = controller;
    let aborted = () => {};
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted)
            throw new ViewError('cancelled', '유지관리를 취소했습니다.');
          return callback(controller.signal);
        }),
        new Promise<never>((_resolve, reject) => {
          aborted = () => reject(new ViewError('cancelled', '유지관리를 취소했습니다.'));
          controller.signal.addEventListener('abort', aborted, { once: true });
        }),
      ]);
    } finally {
      controller.signal.removeEventListener('abort', aborted);
      this.dialog = null;
    }
  }
  private async run(
    rawRoot: string | null,
    operation: LibraryMaintenanceOperation,
  ): Promise<LibraryMaintenanceResult> {
    // Publish the active guard before invoking a dialog or a worker.
    await Promise.resolve();
    let started = false;
    try {
      let input: MaintenanceCommand;
      if (operation === 'reconnect') {
        const selected = await this.ask((signal) =>
          this.dialogs.chooseReconnect(pathValue(rawRoot) ? rawRoot : null, signal),
        );
        if (selected === null || this.cancelled) return { status: 'cancelled' };
        if (!pathValue(selected))
          throw new ViewError('maintenance_root', '연결할 수집 폴더를 선택하세요.');
        input = { command: operation, root: selected };
      } else {
        if (!pathValue(rawRoot))
          throw new ViewError('maintenance_root', '유지관리할 수집 폴더를 먼저 연결하세요.');
        const path = await this.ask((signal) =>
          operation === 'backup'
            ? this.dialogs.chooseBackup(maintenanceBackupFileName(), signal)
            : this.dialogs.chooseRestore(signal),
        );
        if (path === null || this.cancelled) return { status: 'cancelled' };
        if (!pathValue(path) || extname(path).toLowerCase() !== '.sqlite')
          throw new ViewError('maintenance_path', '.sqlite 백업 파일을 선택하세요.');
        if (operation === 'restore') {
          const confirmed = await this.ask((signal) => this.dialogs.confirmRestore(path, signal));
          if (!confirmed || this.cancelled) return { status: 'cancelled' };
        }
        input = { command: operation, root: rawRoot, path };
      }
      if (this.busy())
        throw new ViewError('maintenance_busy', '진행 중인 작업이 끝난 뒤 다시 실행하세요.');
      this.job = this.launch(input);
      started = true;
      const receipt = await this.job.result;
      this.job = null;
      const view = await this.refreshed(input.root);
      return {
        status: 'complete',
        operation,
        view,
        ...(receipt.filePath ? { filePath: receipt.filePath } : {}),
        ...(receipt.automaticBackupPath
          ? { automaticBackupPath: receipt.automaticBackupPath }
          : {}),
        ...(receipt.restoreMode ? { restoreMode: receipt.restoreMode } : {}),
        ...(receipt.historyReviewRequired === undefined
          ? {}
          : { historyReviewRequired: receipt.historyReviewRequired }),
      };
    } catch (error) {
      if (started && rawRoot) await this.refreshed(rawRoot);
      if (
        !started &&
        (this.cancelled || (error instanceof ViewError && error.code === 'cancelled'))
      )
        return { status: 'cancelled' };
      return {
        status: 'error',
        problem:
          error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'maintenance_failed',
                message: '유지관리를 완료하지 못했습니다. 기존 자료와 저장 상태를 확인하세요.',
              },
      };
    }
  }
  private async refreshed(root: string): Promise<CollectionView> {
    let view: CollectionView;
    try {
      view = await this.refresh(root);
    } catch {
      view = { snapshot: null, error: null };
    }
    if (!view.error && view.snapshot?.root === root) return view;
    return {
      snapshot: view.snapshot?.root === root ? view.snapshot : null,
      error: {
        code: 'maintenance_refresh_failed',
        message: '유지관리 후 목록을 갱신하지 못했습니다. 작업을 반복하기 전에 새로고침하세요.',
      },
    };
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.dialog?.abort();
    // An in-flight maintenance worker owns a backup/transaction. Let it finish
    // and refresh before the window closes; the watchdog remains bounded.
    await this.pending;
  }
}
