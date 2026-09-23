import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type {
  CollectionView,
  PostDraft,
  PostDraftResult,
  SavePostDraftInput,
} from '../shared/contracts';
import { validDraftCaption, validDraftMediaIds, validPostDraft } from '../shared/post-draft';
import { ViewError } from './collection';
import { pythonCommand } from './python';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parsePostDraftInput(value: unknown): SavePostDraftInput {
  if (
    object(value) &&
    Object.keys(value).sort().join(',') === 'caption,expectedRevision,mediaIds,postKey' &&
    typeof value.postKey === 'string' &&
    value.postKey.length > 0 &&
    value.postKey.length <= 512 &&
    typeof value.caption === 'string' &&
    validDraftCaption(value.caption) &&
    validDraftMediaIds(value.mediaIds) &&
    (value.expectedRevision === null ||
      (typeof value.expectedRevision === 'number' &&
        Number.isSafeInteger(value.expectedRevision) &&
        value.expectedRevision > 0))
  ) {
    return {
      postKey: value.postKey,
      caption: value.caption,
      mediaIds: [...value.mediaIds],
      expectedRevision: value.expectedRevision,
    };
  }
  throw new ViewError('draft_input', '저장할 미디어와 캡션을 확인하세요.');
}

export function parsePostDraftResult(raw: string, expected: SavePostDraftInput): PostDraft {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate below. */
  }
  if (object(value)) {
    if (
      value.ok === true &&
      value.postKey === expected.postKey &&
      validPostDraft(value.draft) &&
      value.draft.caption === expected.caption &&
      JSON.stringify(value.draft.mediaIds) === JSON.stringify(expected.mediaIds) &&
      value.draft.revision === (expected.expectedRevision ?? 0) + 1
    )
      return value.draft;
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
    'draft_response',
    '등록 결과를 확인하지 못했습니다. 새로고침하여 저장 여부를 먼저 확인하세요.',
  );
}

export type PostDraftCommand = SavePostDraftInput & { root: string };
export type LaunchPostDraft = (input: PostDraftCommand) => {
  result: Promise<PostDraft>;
  cancel(): void;
};

export function launchPostDraft(projectRoot: string, includeAI = false): LaunchPostDraft {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<PostDraft>((resolve, reject) => {
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [
          ...prefix,
          '-I',
          '-B',
          join(projectRoot, 'local-runtime', 'post_draft.py'),
          ...(includeAI ? ['--include-ai'] : []),
        ],
        { timeout: 120_000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(watchdog);
          try {
            // The worker emits success after commit; shutdown must not turn a
            // saved draft into an error that invites another write.
            resolve(parsePostDraftResult(stdout, input));
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

export class PostDraftController {
  private pending: Promise<PostDraftResult> | null = null;
  private job: ReturnType<LaunchPostDraft> | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private launch: LaunchPostDraft,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  save(root: string, input: unknown): Promise<PostDraftResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: {
          code: 'draft_busy',
          message: '진행 중인 작업이 끝난 뒤 게시글을 저장하세요.',
        },
      });
    this.cancelled = false;
    this.pending = this.run(root, input).finally(() => {
      this.job = null;
      this.pending = null;
    });
    return this.pending;
  }
  private async run(root: string, rawInput: unknown): Promise<PostDraftResult> {
    try {
      const input = parsePostDraftInput(rawInput);
      const before = await this.refresh(root);
      if (this.cancelled) throw new ViewError('draft_cancelled', '게시글 저장을 중지했습니다.');
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      if (
        before.snapshot?.warnings.some((warning) => warning.code === 'deletion_recovery_required')
      )
        throw new ViewError('deletion_recovery_required', '중단된 삭제 작업을 먼저 복구하세요.');
      if (before.snapshot?.warnings.some((warning) => warning.code === 'drafts_unavailable'))
        throw new ViewError(
          'drafts_unavailable',
          '기존 게시글을 확인하지 못했습니다. 새로고침한 뒤 저장하세요.',
        );
      const post =
        before.snapshot?.root === root
          ? before.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      if (!post)
        throw new ViewError(
          'draft_source',
          '게시글을 저장할 게시글을 찾을 수 없습니다. 목록을 새로고침하세요.',
        );
      this.job = this.launch({ root, ...input });
      const draft = await this.job.result;
      this.job = null;
      let view: CollectionView;
      try {
        view = await this.refresh(root);
      } catch {
        view = { snapshot: null, error: null };
      }
      const refreshedPost =
        view.snapshot?.root === root
          ? view.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      const refreshedDraft = refreshedPost?.draft;
      const stale =
        !refreshedDraft ||
        refreshedDraft.revision < draft.revision ||
        (refreshedDraft.revision === draft.revision &&
          (refreshedDraft.caption !== draft.caption ||
            JSON.stringify(refreshedDraft.mediaIds) !== JSON.stringify(draft.mediaIds)));
      // A successfully refreshed list may reflect an external post deletion.
      // Keep that current list instead of bringing a removed post back.
      if (view.error || view.snapshot?.root !== root || (refreshedPost && stale)) {
        const snapshot =
          view.snapshot?.root === root && refreshedPost ? view.snapshot : before.snapshot;
        view = {
          snapshot: snapshot && {
            ...snapshot,
            posts: snapshot.posts.map((item) =>
              item.key === input.postKey ? { ...item, draft } : item,
            ),
          },
          error: {
            code: 'draft_refresh_failed',
            message:
              '게시글은 저장됐지만 목록을 갱신하지 못했습니다. 다시 저장하지 말고 새로고침하세요.',
          },
        };
      }
      return { status: 'saved', draft, view };
    } catch (error) {
      return {
        status: 'error',
        problem: this.cancelled
          ? { code: 'draft_cancelled', message: '게시글 저장을 중지했습니다.' }
          : error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'draft_failed',
                message: '게시글을 저장하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
              },
      };
    }
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    this.job?.cancel();
    await this.pending;
  }
}
