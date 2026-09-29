import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { MessageBoxOptions } from 'electron';
import type {
  CollectionView,
  DeletePostDraftResult,
  PostDraftActionInput,
} from '../shared/contracts';
import { validPostDraftActionInput } from '../shared/post-export';
import { ViewError } from './collection';
import { pythonCommand } from './python';

export type PostDraftDeleteCommand = PostDraftActionInput & {
  root: string;
  kind: 'delete';
  expectedSourceDeleted: boolean;
};

export function postDraftDeleteConfirmation(
  sourceDeleted: boolean,
  signal: AbortSignal,
): MessageBoxOptions {
  return {
    type: 'warning',
    title: '등록한 게시글 삭제',
    message: '작성한 게시글을 삭제할까요?',
    detail: sourceDeleted
      ? '수집 탭에서 이미 삭제한 게시글입니다. 등록한 캡션·댓글 정보와 선택하지 않은 항목을 포함한 모든 이미지·영상·편집본 파일을 함께 삭제합니다. 삭제한 파일은 복구할 수 없습니다.\nThreads에 게시된 게시글과 댓글은 유지됩니다.'
      : '작성한 캡션과 미디어 선택·순서가 삭제됩니다. 수집 게시글과 이미지·영상·편집본 파일은 그대로 보존됩니다.\nThreads에 게시된 게시글과 댓글은 유지됩니다.',
    buttons: ['취소', '삭제'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  };
}
export type LaunchPostDraftDelete = (input: PostDraftDeleteCommand) => {
  result: Promise<void>;
  cancel(): void;
};

export function parsePostDraftDeleteResult(raw: string, expected: PostDraftActionInput): void {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate below. */
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (result.ok === true && result.deleted === true && result.postKey === expected.postKey)
      return;
    if (result.ok === false && result.error && typeof result.error === 'object') {
      const error = result.error as Record<string, unknown>;
      if (
        typeof error.code === 'string' &&
        /^[a-z_]{1,64}$/.test(error.code) &&
        typeof error.message === 'string' &&
        error.message.length <= 2000
      )
        throw new ViewError(error.code, error.message);
    }
  }
  throw new ViewError(
    'draft_delete_response',
    '삭제 결과를 확인하지 못했습니다. 새로고침하여 등록 상태를 확인하세요.',
  );
}

export function launchPostDraftDelete(projectRoot: string): LaunchPostDraftDelete {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<void>((resolve, reject) => {
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'post_draft.py')],
        { timeout: 120_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(watchdog);
          try {
            // A successful receipt is emitted only after commit, even if the
            // app was shutting down as the child exited.
            parsePostDraftDeleteResult(stdout, input);
            resolve();
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

export class PostDraftDeleteController {
  private pending: Promise<DeletePostDraftResult> | null = null;
  private job: ReturnType<LaunchPostDraftDelete> | null = null;
  private confirmation: AbortController | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private confirm: (
      input: PostDraftActionInput,
      signal: AbortSignal,
      sourceDeleted: boolean,
    ) => Promise<boolean>,
    private launch: LaunchPostDraftDelete,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  delete(root: string, input: unknown): Promise<DeletePostDraftResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: { code: 'draft_delete_busy', message: '진행 중인 작업이 끝난 뒤 삭제하세요.' },
      });
    this.cancelled = false;
    this.pending = this.run(root, input).finally(() => {
      this.job = null;
      this.confirmation = null;
      this.pending = null;
    });
    return this.pending;
  }
  private async run(root: string, rawInput: unknown): Promise<DeletePostDraftResult> {
    let started = false;
    try {
      if (!validPostDraftActionInput(rawInput))
        throw new ViewError('draft_input', '등록 게시글과 수정 버전을 확인하세요.');
      const input = { ...rawInput };
      const before = await this.refresh(root);
      if (this.cancelled) return { status: 'cancelled' };
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      const warning = before.snapshot?.warnings.find((item) =>
        ['deletion_recovery_required', 'drafts_unavailable'].includes(item.code),
      );
      if (warning) throw new ViewError(warning.code, warning.message);
      const post =
        before.snapshot?.root === root
          ? before.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      if (!post?.draft || post.draft.revision !== input.expectedRevision)
        throw new ViewError(
          'draft_conflict',
          '등록 게시글이 변경되었습니다. 최신 게시글을 다시 열어 삭제하세요.',
        );
      this.confirmation = new AbortController();
      const confirmed = await this.confirm(input, this.confirmation.signal, !!post.sourceDeleted);
      this.confirmation = null;
      if (!confirmed || this.cancelled) return { status: 'cancelled' };
      this.job = this.launch({
        root,
        ...input,
        kind: 'delete',
        expectedSourceDeleted: !!post.sourceDeleted,
      });
      started = true;
      await this.job.result;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { snapshot: null, error: null };
      }
      const refreshed =
        view.snapshot?.root === root
          ? view.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      const stale =
        refreshed?.draft?.createdAt === post.draft.createdAt &&
        refreshed.draft.revision <= input.expectedRevision;
      if (view.error || view.snapshot?.root !== root || stale) {
        const snapshot = view.snapshot?.root === root ? view.snapshot : before.snapshot;
        view = {
          snapshot: snapshot && {
            ...snapshot,
            posts: snapshot.posts
              .filter((item) => !post.sourceDeleted || item.key !== input.postKey)
              .map((item) => {
                if (item.key !== input.postKey) return item;
                const clean = { ...item };
                delete clean.draft;
                return clean;
              }),
          },
          error: {
            code: 'draft_delete_refresh_failed',
            message: '등록 게시글은 삭제됐지만 목록을 갱신하지 못했습니다. 새로고침하세요.',
          },
        };
      }
      return { status: 'deleted', view };
    } catch (error) {
      if (started) {
        try {
          await this.refresh(root);
        } catch {
          /* Retain the worker error. */
        }
      }
      if (this.cancelled || (error instanceof ViewError && error.code === 'cancelled'))
        return { status: 'cancelled' };
      return {
        status: 'error',
        problem:
          error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'draft_delete_failed',
                message: '등록 게시글을 삭제하지 못했습니다. 저장 상태를 확인하세요.',
              },
      };
    }
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    const confirming = this.confirmation !== null;
    this.confirmation?.abort();
    this.job?.cancel();
    if (!confirming) await this.pending;
    // A pending confirmation owns no writes; when it settles the flag prevents launch.
  }
}
