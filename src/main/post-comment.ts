import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type {
  CollectionView,
  PostComment,
  PostCommentResult,
  SavePostCommentInput,
} from '../shared/contracts';
import { validPostDraft } from '../shared/post-draft';
import { ViewError } from './collection';
import { pythonCommand } from './python';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function validLink(link: string): boolean {
  if (!link) return true;
  if (
    !/^https?:\/\//i.test(link) ||
    /\s|\\/.test(link) ||
    Array.from(link).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    return false;
  try {
    const url = new URL(link);
    const authority = link.slice(link.indexOf('://') + 3).split(/[/?#]/, 1)[0];
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !!authority &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !authority.includes('@')
    );
  } catch {
    return false;
  }
}

export function parsePostCommentInput(value: unknown): SavePostCommentInput {
  if (
    object(value) &&
    typeof value.postKey === 'string' &&
    value.postKey.length > 0 &&
    value.postKey.length <= 512 &&
    typeof value.caption === 'string' &&
    typeof value.link === 'string'
  ) {
    const caption = value.caption.trim();
    const link = value.link.trim();
    const invalidControl = Array.from(caption).some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    });
    if (
      caption.length <= 10_000 &&
      link.length <= 2048 &&
      (caption || link) &&
      !invalidControl &&
      validLink(link)
    )
      return { postKey: value.postKey, caption, link };
  }
  throw new ViewError(
    'comment_input',
    '댓글 내용을 입력하거나 올바른 http/https 링크를 입력하세요.',
  );
}

export function parsePostCommentResult(raw: string, expected: SavePostCommentInput): PostComment {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    /* Validate the worker contract below. */
  }
  if (object(value)) {
    const comment = value.comment;
    if (
      value.ok === true &&
      value.postKey === expected.postKey &&
      object(comment) &&
      comment.caption === expected.caption &&
      comment.link === expected.link &&
      typeof comment.updatedAt === 'string' &&
      comment.updatedAt.length <= 64 &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        comment.updatedAt,
      ) &&
      Number.isFinite(Date.parse(comment.updatedAt))
    )
      return { caption: expected.caption, link: expected.link, updatedAt: comment.updatedAt };
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
    'comment_response',
    '댓글 저장 결과를 확인하지 못했습니다. 새로고침하여 저장 여부를 먼저 확인하세요.',
  );
}

export type PostCommentCommand = SavePostCommentInput & { root: string };
export type LaunchPostComment = (input: PostCommentCommand) => {
  result: Promise<PostComment>;
  cancel(): void;
};

export function launchPostComment(projectRoot: string): LaunchPostComment {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<PostComment>((resolve, reject) => {
      let closed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const child = execFile(
        command,
        [...prefix, '-I', '-B', join(projectRoot, 'local-runtime', 'save_post_comment.py')],
        { timeout: 120_000, maxBuffer: 128 * 1024, windowsHide: true, encoding: 'utf8' },
        (_error, stdout) => {
          closed = true;
          clearTimeout(killTimer);
          clearTimeout(watchdog);
          try {
            // The worker emits success after commit; shutdown must not turn a
            // saved comment into an error that invites another write.
            resolve(parsePostCommentResult(stdout, input));
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

export class PostCommentController {
  private pending: Promise<PostCommentResult> | null = null;
  private job: ReturnType<LaunchPostComment> | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private launch: LaunchPostComment,
    private busy: () => boolean = () => false,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  save(root: string, input: unknown): Promise<PostCommentResult> {
    if (this.active || this.busy())
      return Promise.resolve({
        status: 'error',
        problem: {
          code: 'comment_busy',
          message: '진행 중인 작업이 끝난 뒤 댓글을 저장하세요.',
        },
      });
    this.cancelled = false;
    this.pending = this.run(root, input).finally(() => {
      this.job = null;
      this.pending = null;
    });
    return this.pending;
  }
  private async run(root: string, rawInput: unknown): Promise<PostCommentResult> {
    try {
      const input = parsePostCommentInput(rawInput);
      const before = await this.refresh(root);
      if (this.cancelled) throw new ViewError('comment_cancelled', '댓글 저장을 중지했습니다.');
      if (before.error) throw new ViewError(before.error.code, before.error.message);
      if (
        before.snapshot?.warnings.some((warning) => warning.code === 'deletion_recovery_required')
      )
        throw new ViewError('deletion_recovery_required', '중단된 삭제 작업을 먼저 복구하세요.');
      if (before.snapshot?.warnings.some((warning) => warning.code === 'comments_unavailable'))
        throw new ViewError(
          'comments_unavailable',
          '기존 댓글을 확인하지 못했습니다. 새로고침한 뒤 저장하세요.',
        );
      if (before.snapshot?.warnings.some((warning) => warning.code === 'drafts_unavailable'))
        throw new ViewError(
          'drafts_unavailable',
          '등록 게시글을 확인하지 못했습니다. 새로고침한 뒤 댓글을 저장하세요.',
        );
      const post =
        before.snapshot?.root === root
          ? before.snapshot.posts.find((item) => item.key === input.postKey)
          : undefined;
      if (!post)
        throw new ViewError(
          'comment_source',
          '댓글을 저장할 게시글을 찾을 수 없습니다. 목록을 새로고침하세요.',
        );
      if (!validPostDraft(post.draft))
        throw new ViewError('comment_draft_missing', '게시글을 등록한 뒤 댓글 정보를 저장하세요.');
      this.job = this.launch({ root, ...input });
      const comment = await this.job.result;
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
      const refreshedComment = refreshedPost?.comment;
      const savedTime = Date.parse(comment.updatedAt);
      const stale =
        !refreshedComment ||
        Date.parse(refreshedComment.updatedAt) < savedTime ||
        (Date.parse(refreshedComment.updatedAt) === savedTime &&
          (refreshedComment.caption !== comment.caption || refreshedComment.link !== comment.link));
      // A successfully refreshed list may reflect an external post deletion.
      // Keep that current list instead of bringing a removed post back.
      if (view.error || view.snapshot?.root !== root || (refreshedPost && stale)) {
        const snapshot =
          view.snapshot?.root === root && refreshedPost ? view.snapshot : before.snapshot;
        view = {
          snapshot: snapshot && {
            ...snapshot,
            posts: snapshot.posts.map((item) =>
              item.key === input.postKey ? { ...item, comment } : item,
            ),
          },
          error: {
            code: 'comment_refresh_failed',
            message:
              '댓글은 저장됐지만 목록을 갱신하지 못했습니다. 다시 저장하지 말고 새로고침하세요.',
          },
        };
      }
      return { status: 'saved', comment, view };
    } catch (error) {
      return {
        status: 'error',
        problem: this.cancelled
          ? { code: 'comment_cancelled', message: '댓글 저장을 중지했습니다.' }
          : error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'comment_failed',
                message: '댓글을 저장하지 못했습니다. 파일 상태와 저장 공간을 확인하세요.',
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
