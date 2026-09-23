import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DownloadConfirmation, DownloadOverlay, idleDownload } from './DownloadPanel';

it('shows skipped posts as information alongside a successful completion', () => {
  const markup = renderToStaticMarkup(
    createElement(DownloadOverlay, {
      view: {
        ...idleDownload(),
        phase: 'complete',
        batch: {
          totalPosts: 10,
          completedPosts: 10,
          totalFiles: 20,
          completedFiles: 20,
          totalRounds: 1,
          currentRound: 1,
          deferredPosts: 0,
          skippedPosts: 1,
        },
      },
      starting: false,
      enabled: true,
      resume: () => undefined,
      recover: () => undefined,
    }),
  );
  expect(markup).toContain('다운로드 완료');
  expect(markup).toContain('수집이 불완전한 게시글 1개는 다운로드에서 제외했습니다.');
  expect(markup).not.toContain('다운로드 보류');
  expect(markup).not.toContain('download-status-error');
  expect(markup).not.toContain('이어서 다운로드');
});

it('offers resume for an interrupted valid post while identifying only invalid collection cleanup', () => {
  const markup = renderToStaticMarkup(
    createElement(DownloadOverlay, {
      view: {
        ...idleDownload(),
        phase: 'blocked',
        problem: { code: 'interrupted', message: '다운로드가 중단됐습니다.' },
        resumable: true,
        cleanedPosts: 1,
        batch: {
          totalPosts: 3,
          completedPosts: 1,
          totalFiles: 6,
          completedFiles: 3,
          totalRounds: 1,
          currentRound: 1,
          deferredPosts: 0,
        },
      },
      starting: false,
      enabled: true,
      resume: () => undefined,
      recover: () => undefined,
    }),
  );
  expect(markup).toContain('다운로드 중단');
  expect(markup).toContain('수집이 불완전한 게시글 1개를 삭제했습니다.');
  expect(markup).toContain('게시글 1/3 · 파일 3/6');
  expect(markup).toContain('이어서 다운로드');
  expect(markup).not.toContain('미완료 정리');
  expect(markup).not.toContain('미완료 2개 삭제');
});

it('labels restored valid collection data separately from deletion', () => {
  const markup = renderToStaticMarkup(
    createElement(DownloadOverlay, {
      view: { ...idleDownload(), phase: 'complete', cleanedPosts: 0, releasedPosts: 1 },
      starting: false,
      enabled: true,
      resume: () => undefined,
      recover: () => undefined,
    }),
  );
  expect(markup).toContain('수집이 완료된 게시글 1개를 다운로드 대상으로 복원했습니다.');
  expect(markup).not.toContain('삭제했습니다');
});

it('warns before starting or resuming a download', () => {
  for (const resuming of [false, true]) {
    const markup = renderToStaticMarkup(
      createElement(DownloadConfirmation, {
        resuming,
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    expect(markup).toContain('게시글을 확인하거나 편집·작성할 수 없습니다');
    expect(markup).toContain(resuming ? '이어서 다운로드' : '다운로드 시작');
  }
});

it('shows an undismissible full-screen state while waiting between downloads', () => {
  const markup = renderToStaticMarkup(
    createElement(DownloadOverlay, {
      view: {
        ...idleDownload(),
        phase: 'waiting',
        nextAllowedAt: 1_790_147_600,
        batch: {
          totalPosts: 10,
          completedPosts: 3,
          totalFiles: 20,
          completedFiles: 6,
          totalRounds: 2,
          currentRound: 1,
          deferredPosts: 0,
        },
      },
      starting: false,
      enabled: false,
      resume: () => undefined,
      recover: () => undefined,
    }),
  );
  expect(markup).toContain('class="download-overlay"');
  expect(markup).toContain('다음 다운로드를 기다리는 중');
  expect(markup).toContain('게시글 3/10 · 파일 6/20');
  expect(markup).not.toContain('다운로드 상태 닫기');
});
