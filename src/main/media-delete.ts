import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import type { CollectionView, MediaDeleteInput, MediaDeleteResult } from '../shared/contracts';
import { ViewError } from './collection';
import { pythonCommand } from './python';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const label = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 1_000_000;

export function parseMediaDeleteInput(value: unknown): MediaDeleteInput {
  if (
    object(value) &&
    typeof value.postKey === 'string' &&
    value.postKey.length > 0 &&
    value.postKey.length <= 512
  ) {
    if (value.kind === 'post') return { kind: 'post', postKey: value.postKey };
    if (value.kind === 'edit' && identifier(value.mediaId))
      return { kind: 'edit', postKey: value.postKey, mediaId: value.mediaId };
  }
  throw new ViewError('delete_input', '삭제할 게시글이나 편집본을 확인할 수 없습니다.');
}

export interface MediaDeletePlan {
  fingerprint: string;
  fileCount: number;
  editCount: number;
  account: string;
  postId: string;
}
export type MediaDeleteCommand =
  | (MediaDeleteInput &
      (
        | { root: string; command: 'prepare' }
        | { root: string; command: 'commit'; fingerprint: string }
      ))
  | { root: string; command: 'recover' };
export type LaunchMediaDelete = (input: MediaDeleteCommand) => {
  result: Promise<MediaDeletePlan | null>;
  cancel(): void;
};
export type ConfirmMediaDelete = (
  input: MediaDeleteInput,
  plan: MediaDeletePlan,
  signal: AbortSignal,
) => Promise<boolean>;

export function mediaDeleteConfirmation(
  input: MediaDeleteInput,
  plan: MediaDeletePlan,
  signal: AbortSignal,
): MessageBoxOptions {
  const scope =
    input.kind === 'edit'
      ? '선택한 편집본 1개를 삭제합니다. 이 편집본으로 만든 다른 편집본은 유지됩니다.'
      : `게시글의 원본 이미지·영상과 모든 편집본을 삭제합니다. 편집본 ${plan.editCount}개가 포함됩니다.\nExcel에 삭제 기록을 남겨 목록과 다음 다운로드에서 제외합니다.`;
  return {
    type: 'warning',
    title: input.kind === 'edit' ? '편집본 삭제' : '게시글 삭제',
    message: input.kind === 'edit' ? '이 편집본을 삭제할까요?' : '이 게시글을 삭제할까요?',
    detail: `계정: @${plan.account}\n게시글 ID: ${plan.postId}\n삭제할 파일: ${plan.fileCount}개\n\n${scope}\n삭제한 파일은 복구할 수 없습니다.`,
    buttons: ['취소', '삭제'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
}

export function parseMediaDeleteResult(
  raw: string,
  command: MediaDeleteCommand['command'],
): MediaDeletePlan | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate the worker contract below. */
  }
  if (object(value)) {
    if (value.ok === true) {
      if (command === 'commit') return null;
      if (command === 'recover' && count(value.recovered)) return null;
      if (
        command === 'prepare' &&
        typeof value.fingerprint === 'string' &&
        /^[a-f0-9]{64}$/.test(value.fingerprint) &&
        count(value.fileCount) &&
        count(value.editCount) &&
        label(value.account) &&
        label(value.postId)
      )
        return {
          fingerprint: value.fingerprint,
          fileCount: value.fileCount,
          editCount: value.editCount,
          account: value.account,
          postId: value.postId,
        };
    }
    if (
      value.ok === false &&
      object(value.error) &&
      typeof value.error.code === 'string' &&
      /^[a-z_]{1,64}$/.test(value.error.code) &&
      typeof value.error.message === 'string' &&
      value.error.message.length <= 2000
    )
      throw new ViewError(value.error.code, value.error.message);
  }
  throw new ViewError(
    'delete_response',
    '삭제 결과를 확인하지 못했습니다. 새로고침하여 상태를 먼저 확인하세요.',
  );
}

export function launchMediaDelete(projectRoot: string): LaunchMediaDelete {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<MediaDeletePlan | null>((resolve, reject) => {
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'delete_media.py')],
        { timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(watchdog);
          try {
            // The worker reports success after commit and cleanup. Preserve that
            // result even when shutdown races with process exit.
            resolve(parseMediaDeleteResult(stdout, input.command));
          } catch (error) {
            reject(error);
          }
        },
      );
      cancel = () => {
        if (closed) return;
        child.kill('SIGTERM');
        killTimer ??= setTimeout(() => child.kill('SIGKILL'), 40_000);
      };
      const watchdog = setTimeout(() => cancel(), 120_000);
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(input));
    });
    return { result, cancel: () => cancel() };
  };
}

export class MediaDeleteController {
  private pending: Promise<MediaDeleteResult> | null = null;
  private job: ReturnType<LaunchMediaDelete> | null = null;
  private confirmation: AbortController | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private launch: LaunchMediaDelete,
    private confirm: ConfirmMediaDelete,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  delete(root: string, input: unknown): Promise<MediaDeleteResult> {
    return this.start(() => this.run(root, input));
  }
  recover(root: string): Promise<MediaDeleteResult> {
    return this.start(() => this.runRecovery(root));
  }
  private start(run: () => Promise<MediaDeleteResult>): Promise<MediaDeleteResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: { code: 'delete_busy', message: '진행 중인 작업이 끝난 뒤 삭제하세요.' },
      });
    this.cancelled = false;
    this.pending = run().finally(() => {
      this.job = null;
      this.confirmation = null;
      this.pending = null;
    });
    return this.pending;
  }
  private async runRecovery(root: string): Promise<MediaDeleteResult> {
    try {
      this.job = this.launch({ root, command: 'recover' });
      await this.job.result;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { snapshot: null, error: { code: 'delete_refresh_failed', message: '' } };
      }
      if (view.error || view.snapshot?.root !== root)
        view = {
          ...view,
          error: {
            code: 'delete_refresh_failed',
            message: '삭제 작업 복구는 완료됐지만 목록을 갱신하지 못했습니다. 새로고침하세요.',
          },
        };
      return { status: 'deleted', view };
    } catch (error) {
      await this.refreshAfterFailure(root);
      return this.failure(error);
    }
  }
  private async run(root: string, rawInput: unknown): Promise<MediaDeleteResult> {
    let workerStarted = false;
    try {
      const input = parseMediaDeleteInput(rawInput);
      const before = await this.refresh(root);
      if (this.cancelled) return { status: 'cancelled' };
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      if (before.snapshot?.warnings.some((item) => item.code === 'deletion_recovery_required'))
        throw new ViewError('deletion_recovery_required', '중단된 삭제 작업을 먼저 복구하세요.');
      const post =
        before.snapshot?.root === root
          ? before.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      if (
        !post ||
        (input.kind === 'edit' && !post.edits?.some((item) => item.mediaId === input.mediaId))
      )
        throw new ViewError(
          'delete_source',
          '삭제할 항목을 찾을 수 없습니다. 목록을 새로고침하세요.',
        );
      this.job = this.launch({ ...input, root, command: 'prepare' });
      workerStarted = true;
      const plan = await this.job.result;
      this.job = null;
      if (this.cancelled) {
        await this.refreshAfterFailure(root);
        return { status: 'cancelled' };
      }
      if (
        !plan ||
        plan.account !== post.account ||
        plan.postId !== post.postId ||
        (input.kind === 'edit' && (plan.editCount !== 1 || plan.fileCount > 1))
      )
        throw new ViewError(
          'deletion_changed',
          '게시글 정보가 변경됐습니다. 새로고침 후 다시 확인하세요.',
        );
      this.confirmation = new AbortController();
      const confirmed = await this.confirm(input, plan, this.confirmation.signal);
      this.confirmation = null;
      if (!confirmed || this.cancelled) return { status: 'cancelled' };
      this.job = this.launch({ ...input, root, command: 'commit', fingerprint: plan.fingerprint });
      await this.job.result;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { snapshot: null, error: { code: 'delete_refresh_failed', message: '' } };
      }
      if (view.error || view.snapshot?.root !== root)
        view = {
          snapshot: before.snapshot && {
            ...before.snapshot,
            posts:
              input.kind === 'post'
                ? before.snapshot.posts.filter((item) => item.key !== input.postKey)
                : before.snapshot.posts.map((item) =>
                    item.key === input.postKey
                      ? {
                          ...item,
                          edits: item.edits?.filter((edit) => edit.mediaId !== input.mediaId),
                        }
                      : item,
                  ),
          },
          error: {
            code: 'delete_refresh_failed',
            message:
              '삭제는 완료됐지만 목록을 갱신하지 못했습니다. 다시 삭제하지 말고 새로고침하세요.',
          },
        };
      return { status: 'deleted', view };
    } catch (error) {
      if (workerStarted) await this.refreshAfterFailure(root);
      return this.failure(error);
    }
  }
  private async refreshAfterFailure(root: string): Promise<void> {
    this.job = null;
    try {
      await this.refresh(root);
    } catch {
      // Keep the worker error; a later current()/refresh can show recovery state.
    }
  }
  private failure(error: unknown): MediaDeleteResult {
    if (this.cancelled || (error instanceof ViewError && error.code === 'cancelled'))
      return { status: 'cancelled' };
    return {
      status: 'error',
      problem:
        error instanceof ViewError
          ? { code: error.code, message: error.message }
          : {
              code: 'delete_failed',
              message: '삭제하지 못했습니다. 파일 상태와 사용 권한을 확인하세요.',
            },
    };
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.confirmation?.abort();
    this.job?.cancel();
    await this.pending;
  }
}
