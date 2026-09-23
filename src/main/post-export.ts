import { execFile } from 'node:child_process';
import { basename, extname, isAbsolute, join } from 'node:path';
import type { CollectionView, PostExportResult } from '../shared/contracts';
import {
  postDraftExportIssue,
  postExportIssue,
  validPostDraftActionInput,
} from '../shared/post-export';
import { ViewError } from './collection';
import { pythonCommand } from './python';

export type LaunchExport = (input: {
  root: string;
  postKey: string;
  destination: string;
  expectedRevision?: number;
}) => {
  result: Promise<void>;
  cancel(): void;
};

export function archiveFileName(postId: string): string {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(postId) ||
    /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(postId)
  )
    throw new ViewError('export_post_id', '게시글 ID를 파일명으로 사용할 수 없습니다.');
  return `${postId}.zip`;
}

export function parseExportResult(raw: string, expectedFileName: string): void {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    /* Reject anything except the worker contract. */
  }
  if (data && typeof data === 'object' && 'ok' in data) {
    if (data.ok === true && 'fileName' in data && data.fileName === expectedFileName) return;
    if (
      data.ok === false &&
      'error' in data &&
      data.error &&
      typeof data.error === 'object' &&
      'code' in data.error &&
      typeof data.error.code === 'string' &&
      /^[a-z_]{1,64}$/.test(data.error.code) &&
      'message' in data.error &&
      typeof data.error.message === 'string' &&
      data.error.message.length <= 2000
    )
      throw new ViewError(data.error.code, data.error.message);
  }
  throw new ViewError(
    'export_response',
    'ZIP 저장 결과를 확인하지 못했습니다. 저장 폴더를 확인하세요.',
  );
}

export function launchExport(projectRoot: string, includeAI = false): LaunchExport {
  return (input) => {
    const { command, prefix } = pythonCommand(projectRoot);
    let cancel = () => {};
    const result = new Promise<void>((resolve, reject) => {
      const child = execFile(
        command,
        [
          ...prefix,
          '-I',
          '-B',
          join(projectRoot, 'local-runtime', 'export_post.py'),
          ...(includeAI ? ['--include-ai'] : []),
        ],
        { timeout: 600_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' },
        (error, stdout) => {
          try {
            if (!stdout.trim())
              throw new ViewError(
                'export_worker',
                'ZIP을 저장하지 못했습니다. 저장 위치와 여유 공간을 확인하세요.',
              );
            parseExportResult(stdout, basename(input.destination));
            if (error)
              throw new ViewError(
                'export_worker',
                'ZIP 저장을 완료하지 못했습니다. 저장 폴더를 확인하세요.',
              );
            resolve();
          } catch (reason) {
            reject(reason);
          }
        },
      );
      // The worker cleans up its unpublished temporary file on SIGTERM.
      cancel = () => {
        child.kill('SIGTERM');
      };
      child.stdin?.on('error', () => {});
      child.stdin?.end(JSON.stringify(input));
    });
    return { result, cancel: () => cancel() };
  };
}

export class PostExportController {
  private pending: Promise<PostExportResult> | null = null;
  private job: ReturnType<LaunchExport> | null = null;
  private cancelled = false;
  constructor(
    private refresh: (root: string) => Promise<CollectionView>,
    private chooseDestination: (fileName: string) => Promise<string | null>,
    private launch: LaunchExport,
  ) {}
  get active(): boolean {
    return this.pending !== null;
  }
  export(root: string, postKey: string): Promise<PostExportResult> {
    return this.start(() => this.run(root, postKey));
  }
  exportDraft(root: string, input: unknown): Promise<PostExportResult> {
    return this.start(async () => {
      if (!validPostDraftActionInput(input))
        return {
          status: 'error',
          problem: { code: 'draft_input', message: '등록 게시글과 수정 버전을 확인하세요.' },
        };
      return this.run(root, input.postKey, input.expectedRevision);
    });
  }
  private start(run: () => Promise<PostExportResult>): Promise<PostExportResult> {
    if (this.pending)
      return Promise.resolve({
        status: 'error',
        problem: { code: 'export_busy', message: '다른 게시글의 ZIP을 저장하고 있습니다.' },
      });
    this.cancelled = false;
    this.pending = run().finally(() => {
      this.pending = null;
      this.job = null;
    });
    return this.pending;
  }
  private async run(
    root: string,
    postKey: string,
    expectedRevision?: number,
  ): Promise<PostExportResult> {
    try {
      const view = await this.refresh(root);
      if (this.cancelled) return { status: 'cancelled' };
      if (view.error) throw new ViewError(view.error.code, view.error.message);
      if (view.snapshot?.warnings.some((item) => item.code === 'deletion_recovery_required'))
        throw new ViewError('deletion_recovery_required', '중단된 삭제 작업을 먼저 복구하세요.');
      if (
        expectedRevision !== undefined &&
        view.snapshot?.warnings.some((item) => item.code === 'drafts_unavailable')
      )
        throw new ViewError(
          'drafts_unavailable',
          '등록 게시글을 읽을 수 없습니다. 저장 상태를 확인하세요.',
        );
      const post =
        view.snapshot?.root === root
          ? view.snapshot.posts.find((item) => item.key === postKey)
          : undefined;
      if (!post)
        throw new ViewError(
          'export_post_missing',
          '게시글을 찾을 수 없습니다. 목록을 새로고침하세요.',
        );
      if (expectedRevision !== undefined && post.draft?.revision !== expectedRevision)
        throw new ViewError(
          'draft_conflict',
          '등록 게시글이 변경되었습니다. 최신 게시글을 다시 열어 다운로드하세요.',
        );
      const issue =
        expectedRevision === undefined ? postExportIssue(post) : postDraftExportIssue(post);
      if (issue) throw new ViewError('export_media_missing', issue);
      const destination = await this.chooseDestination(archiveFileName(post.postId));
      if (this.cancelled || destination === null) return { status: 'cancelled' };
      if (!isAbsolute(destination) || extname(destination).toLowerCase() !== '.zip')
        throw new ViewError('export_destination', '.zip 확장자로 저장 위치를 선택하세요.');
      this.job = this.launch({
        root,
        postKey,
        destination,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
      });
      await this.job.result;
      return { status: 'saved', fileName: basename(destination) };
    } catch (error) {
      if (this.cancelled) return { status: 'cancelled' };
      return {
        status: 'error',
        problem:
          error instanceof ViewError
            ? { code: error.code, message: error.message }
            : {
                code: 'export_failed',
                message: 'ZIP을 저장하지 못했습니다. 저장 위치와 파일 상태를 확인하세요.',
              },
      };
    }
  }
  async shutdown(): Promise<void> {
    this.cancelled = true;
    if (this.job) {
      this.job.cancel();
      await this.pending;
    }
    // A pending native dialog owns no output yet. Closing its window cancels it;
    // the cancelled check above prevents it from launching a worker afterwards.
  }
}
