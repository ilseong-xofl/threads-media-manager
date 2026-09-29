import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DownloadView } from '../shared/contracts';
import {
  DownloadConfirmation,
  DownloadOverlay,
  activeDownload,
  downloadOutcome,
  idleDownload,
} from './DownloadPanel';

function markup(view: DownloadView, starting = false) {
  return renderToStaticMarkup(createElement(DownloadOverlay, { view, starting }));
}
const batch = {
  totalPosts: 10,
  completedPosts: 10,
  totalFiles: 20,
  completedFiles: 20,
  totalRounds: 1,
  currentRound: 1,
  deferredPosts: 0,
  skippedPosts: 1,
};

describe('download result notifications', () => {
  it('puts successful completion and excluded-post information into one toast without a result modal', () => {
    const view: DownloadView = { ...idleDownload(), phase: 'complete', batch };
    const notice = downloadOutcome(view)!;
    expect(notice.error).toBe(false);
    expect(notice.message).toContain('다운로드 완료');
    expect(notice.message).toContain('게시글 10/10 · 파일 20/20');
    expect(notice.message).toContain('수집이 불완전한 게시글 1개는 다운로드에서 제외했습니다.');
    expect(notice.message).not.toContain('다운로드 보류');
    expect(markup(view)).toBe('');
  });
  it('preserves downloaded and exact-hash duplicate totals in the toast', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'complete',
      downloadedPosts: 2,
      duplicatePostsRemoved: 1,
    };
    expect(downloadOutcome(view)?.message).toContain('게시글 2개 다운로드 · 중복 1개 제거');
    expect(markup(view)).toBe('');
  });
  it('preserves interrupted progress and distinguishes invalid collection cleanup from unfinished posts', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'blocked',
      problem: { code: 'interrupted', message: '다운로드가 중단됐습니다.' },
      resumable: true,
      cleanedPosts: 1,
      batch: {
        ...batch,
        totalPosts: 3,
        completedPosts: 1,
        totalFiles: 6,
        completedFiles: 3,
        skippedPosts: 0,
      },
    };
    const notice = downloadOutcome(view)!;
    expect(notice.error).toBe(true);
    expect(notice.message).toContain('다운로드가 중단됐습니다.');
    expect(notice.message).toContain('게시글 1/3 · 파일 3/6');
    expect(notice.message).toContain('수집이 불완전한 게시글 1개를 삭제했습니다.');
    expect(notice.message).not.toContain('미완료 2개 삭제');
    expect(markup(view)).toBe('');
    expect(view.resumable).toBe(true);
    expect(view.problem?.code).toBe('interrupted');
  });
  it('labels restored valid collection data separately from deletion', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'complete',
      cleanedPosts: 0,
      releasedPosts: 1,
    };
    expect(downloadOutcome(view)?.message).toContain(
      '수집이 완료된 게시글 1개를 다운로드 대상으로 복원했습니다.',
    );
    expect(downloadOutcome(view)?.message).not.toContain('삭제했습니다');
    expect(markup(view)).toBe('');
  });
  it('keeps recovery-only errors and server wait information available for the toast', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'blocked',
      recoverable: true,
      nextAllowedAt: 1_790_147_600,
      problem: { code: 'rate_limit', message: '서버가 요청 대기를 요구했습니다.' },
      batch: { ...batch, completedPosts: 3, deferredPosts: 2 },
    };
    const notice = downloadOutcome(view)!;
    expect(notice.error).toBe(true);
    expect(notice.message).toContain('서버가 요청 대기를 요구했습니다.');
    expect(notice.message).toContain('다음 다운로드');
    expect(notice.message).toContain('KST');
    expect(notice.message).toContain('보류된 게시글 2개');
    expect(markup(view)).toBe('');
    expect(view.recoverable).toBe(true);
  });
  it('uses the same outcome key for polling copies and a new key for a new result', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'complete',
      revision: 7,
      downloadedPosts: 2,
      duplicatePostsRemoved: 1,
    };
    const key = downloadOutcome(view)!.key;
    expect(downloadOutcome(structuredClone(view))!.key).toBe(key);
    expect(downloadOutcome({ ...view, revision: 8 })!.key).not.toBe(key);
    expect(downloadOutcome({ ...view, duplicatePostsRemoved: 0 })!.key).not.toBe(key);
  });
  it('does not emit a result for idle state, active work, or a new operation still starting', () => {
    expect(downloadOutcome(idleDownload())).toBeNull();
    expect(downloadOutcome({ ...idleDownload(), phase: 'checking' })).toBeNull();
    expect(
      downloadOutcome({ ...idleDownload(), phase: 'complete', downloadedPosts: 2 }, true),
    ).toBeNull();
  });
});

describe('download progress and confirmation', () => {
  it('keeps the overlay active while checking first-media duplicates', () => {
    const view: DownloadView = { ...idleDownload(), phase: 'deduplicating', received: 1, total: 2 };
    const output = markup(view);
    expect(activeDownload(view)).toBe(true);
    expect(output).toContain('중복 게시글 확인 중');
    expect(output).toContain('중복 확인 1/2');
    expect(output).not.toContain('download-status-dismissible');
    expect(output).not.toContain('다운로드 상태 닫기');
    expect(downloadOutcome(view)).toBeNull();
  });
  it('warns before starting or resuming a download', () => {
    for (const resuming of [false, true]) {
      const output = renderToStaticMarkup(
        createElement(DownloadConfirmation, {
          resuming,
          onCancel: () => undefined,
          onConfirm: () => undefined,
        }),
      );
      expect(output).toContain('게시글을 확인하거나 편집·작성할 수 없습니다');
      expect(output).toContain('첫 이미지·영상의 SHA-256');
      expect(output).toContain(resuming ? '이어서 다운로드' : '다운로드 시작');
    }
  });
  it('keeps an undismissible full-screen state while waiting between downloads', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'waiting',
      nextAllowedAt: 1_790_147_600,
      batch: { ...batch, completedPosts: 3, completedFiles: 6, totalRounds: 2 },
    };
    const output = markup(view);
    expect(output).toContain('class="download-overlay"');
    expect(output).toContain('다음 다운로드를 기다리는 중');
    expect(output).toContain('게시글 3/10 · 파일 6/20');
    expect(output).toContain('다음 다운로드');
    expect(output).not.toContain('다운로드 상태 닫기');
    expect(downloadOutcome(view)).toBeNull();
  });
  it('keeps file transfer progress in the active modal without rendering stale failure messages', () => {
    const view: DownloadView = {
      ...idleDownload(),
      phase: 'downloading',
      received: 1024,
      total: 2048,
      problem: { code: 'old_problem', message: '지난 작업의 오류' },
    };
    const output = markup(view);
    expect(output).toContain('현재 파일 다운로드 진행');
    expect(output).toContain('1 KB / 2 KB');
    expect(output).not.toContain('지난 작업의 오류');
    expect(downloadOutcome(view)).toBeNull();
  });
});
