import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { DownloadBatch, DownloadTarget, DownloadView, Problem } from '../shared/contracts';
import { ViewError } from './collection';
import { pythonCommand } from './python';

interface Plan extends DownloadTarget {
  source: string;
  sourceHash: string;
  runId: string;
  urlHash: string;
}
interface Result {
  target?: DownloadTarget | null;
  plan?: Plan | null;
  nextAllowedAt: number | null;
  problem: Problem | null;
  recoverable: boolean;
  resumable?: boolean;
  batch?: DownloadBatch | null;
  cleanedPosts?: number;
  releasedPosts?: number;
  downloadedPosts?: number;
  duplicatePostsRemoved?: number;
}
interface Progress {
  phase: 'checking' | 'downloading' | 'validating' | 'deduplicating' | 'recovering' | 'waiting';
  received: number;
  total: number | null;
  target?: DownloadTarget | null;
  nextAllowedAt?: number | null;
  batch?: DownloadBatch | null;
}
interface Process {
  result: Promise<Result>;
  cancel(): void;
}
export type Launch = (
  root: string,
  input: Record<string, unknown>,
  progress: (event: Progress) => void,
) => Process;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096;
const target = (v: unknown): v is DownloadTarget =>
  object(v) &&
  text(v.account) &&
  /^[A-Za-z0-9_.]{1,64}$/.test(v.account) &&
  text(v.postId) &&
  /^[A-Za-z0-9_-]{1,128}$/.test(v.postId) &&
  integer(v.ordinal) &&
  v.ordinal > 0 &&
  ['image', 'video'].includes(String(v.kind));
const publicTarget = (v: DownloadTarget): DownloadTarget => ({
  account: v.account,
  postId: v.postId,
  ordinal: v.ordinal,
  kind: v.kind,
});
const deadline = (value: unknown): value is number | null =>
  value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);

function batchProgress(value: unknown): DownloadBatch | null {
  if (value === null) return null;
  const fields = [
    'totalPosts',
    'completedPosts',
    'totalFiles',
    'completedFiles',
    'totalRounds',
    'currentRound',
    'deferredPosts',
  ] as const;
  if (
    !object(value) ||
    fields.some((field) => !integer(value[field])) ||
    (value.skippedPosts !== undefined && !integer(value.skippedPosts))
  )
    throw new ViewError('worker_response', '다운로드 진행 수량을 검증하지 못했습니다.');
  const batch = Object.fromEntries(
    fields.map((field) => [field, value[field]]),
  ) as unknown as DownloadBatch;
  if (
    batch.completedPosts > batch.totalPosts ||
    batch.completedFiles > batch.totalFiles ||
    batch.currentRound > batch.totalRounds
  )
    throw new ViewError('worker_response', '다운로드 진행 수량이 올바르지 않습니다.');
  if (value.skippedPosts !== undefined) batch.skippedPosts = Number(value.skippedPosts);
  return batch;
}

function parseProgress(value: Record<string, unknown>): Progress {
  if (
    !['checking', 'downloading', 'validating', 'deduplicating', 'recovering', 'waiting'].includes(
      String(value.phase),
    ) ||
    !integer(value.received) ||
    !(value.total === null || integer(value.total)) ||
    (value.target !== undefined && value.target !== null && !target(value.target)) ||
    (value.nextAllowedAt !== undefined && !deadline(value.nextAllowedAt))
  )
    throw new ViewError('worker_response', '다운로드 진행 응답이 올바르지 않습니다.');
  return {
    phase: value.phase as Progress['phase'],
    received: value.received,
    total: value.total as number | null,
    ...(value.target !== undefined
      ? { target: value.target ? publicTarget(value.target as DownloadTarget) : null }
      : {}),
    ...(value.nextAllowedAt !== undefined
      ? { nextAllowedAt: value.nextAllowedAt as number | null }
      : {}),
    ...(value.batch !== undefined ? { batch: batchProgress(value.batch) } : {}),
  };
}

export function parseResult(value: unknown): Result {
  const invalid = () => {
    throw new ViewError('worker_response', '다운로드 상태 응답을 검증하지 못했습니다.');
  };
  if (
    !object(value) ||
    !deadline(value.nextAllowedAt) ||
    !(
      value.problem === null ||
      (object(value.problem) && text(value.problem.code) && text(value.problem.message))
    ) ||
    typeof value.recoverable !== 'boolean' ||
    (value.resumable !== undefined && typeof value.resumable !== 'boolean') ||
    (value.cleanedPosts !== undefined && !integer(value.cleanedPosts)) ||
    (value.releasedPosts !== undefined && !integer(value.releasedPosts)) ||
    (value.downloadedPosts !== undefined && !integer(value.downloadedPosts)) ||
    (value.duplicatePostsRemoved !== undefined && !integer(value.duplicatePostsRemoved)) ||
    (value.duplicatePostsRemoved !== undefined &&
      (value.downloadedPosts === undefined ||
        Number(value.duplicatePostsRemoved) > Number(value.downloadedPosts)))
  )
    return invalid();
  if (value.target !== undefined && value.target !== null && !target(value.target))
    return invalid();
  if (value.plan !== undefined && value.plan !== null) {
    const p = value.plan;
    if (
      !target(p) ||
      !object(p) ||
      !text(p.source) ||
      !/^results\/\d{4}\/\d{2}\/threads-\d{4}-\d{2}-\d{2}\.xlsx$/.test(p.source) ||
      !text(p.sourceHash) ||
      !/^[a-f0-9]{64}$/.test(p.sourceHash) ||
      !text(p.urlHash) ||
      !/^[a-f0-9]{64}$/.test(p.urlHash) ||
      !text(p.runId)
    )
      return invalid();
  }
  const raw = value as unknown as Result;
  const cleanTarget = raw.target ? publicTarget(raw.target) : null;
  const plan = raw.plan
    ? {
        ...publicTarget(raw.plan),
        source: raw.plan.source,
        sourceHash: raw.plan.sourceHash,
        urlHash: raw.plan.urlHash,
        runId: raw.plan.runId,
      }
    : null;
  if (plan && JSON.stringify(cleanTarget) !== JSON.stringify(publicTarget(plan))) return invalid();
  return {
    target: cleanTarget,
    plan,
    recoverable: raw.recoverable,
    resumable: raw.resumable ?? false,
    ...(raw.cleanedPosts !== undefined ? { cleanedPosts: raw.cleanedPosts } : {}),
    ...(raw.releasedPosts !== undefined ? { releasedPosts: raw.releasedPosts } : {}),
    ...(raw.downloadedPosts !== undefined ? { downloadedPosts: raw.downloadedPosts } : {}),
    ...(raw.duplicatePostsRemoved !== undefined
      ? { duplicatePostsRemoved: raw.duplicatePostsRemoved }
      : {}),
    nextAllowedAt: raw.nextAllowedAt,
    problem: raw.problem ? { code: raw.problem.code, message: raw.problem.message } : null,
    ...(value.batch !== undefined ? { batch: batchProgress(value.batch) } : {}),
  };
}

export function launchWorker(project: string): Launch {
  return (root, input, progress) => {
    const { command, prefix } = pythonCommand(project);
    const child = spawn(
      command,
      [
        ...prefix,
        '-I',
        '-B',
        '-u',
        join(project, 'local-runtime', 'download_ui.py'),
        '--collection-root',
        root,
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let closed = false;
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (closed) return;
      child.stdin.write('{"cancel":true}\n');
      cancelTimer ??= setTimeout(() => child.kill('SIGKILL'), 40_000);
    };
    const result = new Promise<Result>((resolve, reject) => {
      let buffer = '';
      let bytes = 0;
      let result: Result | undefined;
      let failure: ViewError | undefined;
      let timeout: ReturnType<typeof setTimeout>;
      const batch = ['batch', 'resume', 'cleanup-source'].includes(String(input.command));
      let outputWindow = Date.now();
      const armTimeout = () => {
        clearTimeout(timeout);
        timeout = setTimeout(
          () => {
            if (failure) return;
            failure = new ViewError(
              'worker_timeout',
              '처리 시간이 초과되어 중지합니다. 로컬 저장 상태를 확인하세요.',
            );
            cancel();
          },
          input.command === 'download' || batch ? 660_000 : 60_000,
        );
      };
      armTimeout();
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {}); // Never expose subprocess diagnostics/URLs to the renderer.
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (failure) return;
        // A batch can run for hours. Limit its output per minute, retaining the
        // same per-line memory bound and a watchdog between validated events.
        if (batch && Date.now() - outputWindow >= 60_000) {
          bytes = 0;
          outputWindow = Date.now();
        }
        bytes += Buffer.byteLength(chunk);
        buffer += chunk;
        if (bytes > 2 * 1024 * 1024 || buffer.length > 64 * 1024) {
          failure = new ViewError(
            'worker_response',
            '다운로드 상태 응답이 허용 크기를 초과했습니다.',
          );
          buffer = '';
          cancel();
          return;
        }
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const message: unknown = JSON.parse(line);
            if (!object(message)) throw new Error();
            if (message.type === 'result') {
              if (result || failure) {
                if (!failure) throw new Error();
                continue;
              }
              if (message.ok === true) result = parseResult(message.result);
              else if (
                object(message.error) &&
                text(message.error.code) &&
                text(message.error.message)
              )
                failure = new ViewError(message.error.code, message.error.message);
              else throw new Error();
            } else if (message.type === 'progress' && !result && !failure) {
              progress(parseProgress(message));
              if (batch) armTimeout();
            } else throw new Error();
          } catch {
            failure = new ViewError('worker_response', '다운로드 상태 응답이 올바르지 않습니다.');
            buffer = '';
            cancel();
            return;
          }
          if (failure) {
            buffer = '';
            cancel();
            return;
          }
        }
      });
      child.once('error', () => {
        failure ??= new ViewError(
          'runtime_unavailable',
          '다운로드 실행기를 시작할 수 없습니다. Python 개발 환경을 확인하세요.',
        );
      });
      child.once('close', (code) => {
        closed = true;
        clearTimeout(timeout);
        clearTimeout(cancelTimer);
        if (failure) reject(failure);
        else if (!result || code !== 0 || buffer.trim())
          reject(
            new ViewError(
              'worker_exit',
              '실행기가 예기치 않게 종료됐습니다. 로컬 저장 복구를 확인하세요.',
            ),
          );
        else resolve(result);
      });
      child.stdin.write(JSON.stringify(input) + '\n');
    });
    return { result, cancel };
  };
}

const empty = (): DownloadView => ({
  phase: 'idle',
  target: null,
  nextAllowedAt: null,
  problem: null,
  recoverable: false,
  received: 0,
  total: null,
  revision: 0,
});
export class DownloadController {
  view = empty();
  private root: string | null = null;
  private plan: Plan | null = null;
  private process: Process | null = null;
  private completion: Promise<void> | null = null;
  get active(): boolean {
    return this.completion !== null;
  }
  constructor(
    private launch: Launch,
    private afterWrite: () => Promise<unknown>,
  ) {}
  reset(): void {
    if (!this.active) {
      this.view = { ...empty(), revision: this.view.revision + 1 };
      this.root = null;
      this.plan = null;
    }
  }
  resetForRoot(root: string): void {
    if (this.active || root === this.root) return;
    this.reset();
    this.root = root;
  }
  prepare(root: string, account: string): DownloadView {
    if (this.active) return this.view;
    this.root = root;
    this.plan = null;
    this.view = { ...empty(), phase: 'checking', revision: this.view.revision + 1 };
    this.run({ command: 'preview', account }, false);
    return this.view;
  }
  start(root: string): DownloadView {
    if (this.active || this.view.phase !== 'ready' || root !== this.root || !this.plan)
      return this.view;
    this.view = { ...this.view, phase: 'downloading', problem: null, received: 0, total: null };
    this.run({ command: 'download', plan: this.plan }, true);
    return this.view;
  }
  startAll(root: string): DownloadView {
    if (this.active) return this.view;
    this.root = root;
    this.plan = null;
    this.view = { ...empty(), phase: 'checking', revision: this.view.revision + 1 };
    this.run({ command: 'batch' }, true);
    return this.view;
  }
  inspect(root: string): DownloadView {
    if (this.active) return this.view;
    // Validate collection records locally without touching interrupted downloads.
    // A no-op preserves dismissed notices and the completion timer.
    if (root !== this.root) this.view = { ...empty(), revision: this.view.revision + 1 };
    this.root = root;
    this.plan = null;
    this.run({ command: 'cleanup-source' }, true);
    return this.view;
  }
  resume(root: string): DownloadView {
    if (this.active) return this.view;
    this.root = root;
    this.plan = null;
    this.view = { ...empty(), phase: 'recovering', revision: this.view.revision + 1 };
    this.run({ command: 'resume' }, true);
    return this.view;
  }
  recover(root: string): DownloadView {
    if (this.active) return this.view;
    this.root = root;
    this.plan = null;
    this.view = { ...empty(), phase: 'recovering', revision: this.view.revision + 1 };
    this.run({ command: 'recover' }, true);
    return this.view;
  }
  stop(): DownloadView {
    if (this.active) {
      this.view = { ...this.view, phase: 'stopping' };
      this.process?.cancel();
    }
    return this.view;
  }
  async shutdown(): Promise<void> {
    this.stop();
    await this.completion;
  }
  async settled(): Promise<void> {
    await this.completion;
  }
  private run(input: Record<string, unknown>, writes: boolean): void {
    this.completion = (async () => {
      // Establish the active guard before starting a process, even if launch fails synchronously.
      await Promise.resolve();
      let outcome: DownloadView | null = null;
      let changed = false;
      const inspection = input.command === 'status' || input.command === 'cleanup-source';
      try {
        const worker = this.launch(this.root!, input, (event) => {
          if (this.view.phase !== 'stopping') this.view = { ...this.view, ...event };
        });
        this.process = worker;
        if (this.view.phase === 'stopping') worker.cancel();
        const result = await worker.result;
        changed = (result.cleanedPosts ?? 0) + (result.releasedPosts ?? 0) > 0;
        if (input.command === 'preview' && this.view.phase === 'stopping')
          throw new ViewError('cancelled', '대상 확인을 중지했습니다.');
        this.plan = input.command === 'preview' ? (result.plan ?? null) : null;
        outcome = {
          ...this.view,
          target: result.target ?? this.view.target,
          nextAllowedAt: result.nextAllowedAt,
          problem:
            inspection && !changed && this.view.problem?.code === result.problem?.code
              ? this.view.problem
              : result.problem,
          recoverable: result.recoverable,
          resumable: result.resumable ?? false,
          batch: result.batch ?? this.view.batch,
          ...(changed
            ? { cleanedPosts: result.cleanedPosts, releasedPosts: result.releasedPosts }
            : {}),
          ...(result.downloadedPosts !== undefined
            ? {
                downloadedPosts: result.downloadedPosts,
                duplicatePostsRemoved: result.duplicatePostsRemoved,
              }
            : {}),
          phase:
            result.problem || result.recoverable || result.resumable
              ? 'blocked'
              : input.command === 'preview'
                ? this.plan
                  ? 'ready'
                  : 'blocked'
                : changed || ['download', 'batch', 'resume'].includes(String(input.command))
                  ? 'complete'
                  : inspection && this.view.phase === 'complete'
                    ? 'complete'
                    : 'idle',
        };
      } catch (error) {
        this.plan = null;
        outcome = {
          ...this.view,
          phase: 'error',
          problem:
            error instanceof ViewError
              ? { code: error.code, message: error.message }
              : {
                  code: 'download_error',
                  message: '다운로드 처리를 중단했습니다. 저장 상태를 확인하세요.',
                },
          recoverable:
            writes ||
            this.view.recoverable ||
            (error instanceof ViewError && ['busy', 'state_busy'].includes(error.code)),
        };
      } finally {
        this.process = null;
        if (writes) {
          try {
            await this.afterWrite();
          } catch {
            // CollectionController retains its own refresh error for the UI.
          }
        }
        // Publish a terminal state only after the saved library is refreshed.
        // stop/shutdown during refresh must not leave an inactive 'stopping' view.
        this.view = {
          ...(outcome ?? this.view),
          revision: this.view.revision + (inspection && !changed ? 0 : 1),
        };
        this.completion = null;
      }
    })();
  }
}
