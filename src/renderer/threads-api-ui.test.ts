import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ThreadsPublication, ThreadsState } from '../shared/threads-api';
import type { Post } from '../shared/contracts';
import {
  isPublishedPost,
  isPublishedReply,
  ThreadsPublishedBadge,
  ThreadsReplyPublishedBadge,
} from './ThreadsPublishedBadge';
import { threadsUploadLabel, ThreadsUploadOverlay } from './ThreadsUploadOverlay';
import { RegisteredPostCard } from './RegisteredPostCard';
import { PostRegistrationModal } from './PostRegistrationModal';
import {
  latestPublication,
  publicationBlocksUpload,
  ThreadsMetrics,
  ThreadsPublicationPanel,
} from './ThreadsPublicationPanel';
import { ThreadsAccountSettings } from './ThreadsAccountSettings';
import { FileServerSettings } from './FileServerSettings';
import type { ThreadsUi } from './use-threads-api';

const { toastMessage, notify } = vi.hoisted(() => ({ toastMessage: vi.fn(), notify: vi.fn() }));
vi.mock('./toast', () => ({ useToast: () => notify, useToastMessage: toastMessage }));
beforeEach(() => {
  vi.clearAllMocks();
});

function publication(overrides: Partial<ThreadsPublication> = {}): ThreadsPublication {
  return {
    id: 'entry',
    postKey: 'source:post',
    accountId: '123',
    username: 'publisher',
    kind: 'post',
    text: 'Saved caption',
    draftRevision: 1,
    commentUpdatedAt: null,
    status: 'published',
    remoteId: '456',
    createdAt: '2026-09-28T00:00:00Z',
    publishedAt: '2026-09-28T00:01:00Z',
    metrics: null,
    metricsUpdatedAt: null,
    problem: null,
    metricsProblem: null,
    ...overrides,
  };
}
function state(overrides: Partial<ThreadsState> = {}): ThreadsState {
  return {
    account: {
      id: '123',
      username: 'publisher',
      connectedAt: '2026-09-28T00:00:00Z',
      expiresAt: '2030-01-01T00:00:00Z',
      lastRefreshedAt: null,
      lastRefreshAttemptAt: null,
    },
    accountProblem: null,
    storageConfigured: true,
    fileServer: null,
    publications: [],
    recentPublications: [],
    busy: false,
    syncing: false,
    lastSyncAt: null,
    problem: null,
    ...overrides,
  };
}
function ui(value: ThreadsState | null): ThreadsUi {
  return {
    state: value,
    loading: false,
    working: false,
    error: null,
    refresh: async () => undefined,
    run: async () => true,
  };
}
it('finds publication only for the source, connected account, and requested kind', () => {
  const matching = publication();
  const value = state({
    publications: [
      publication({ id: 'other-account', accountId: '999', createdAt: '2026-09-29T00:00:00Z' }),
      publication({ id: 'reply', kind: 'reply' }),
      publication({ id: 'other-source', postKey: 'elsewhere' }),
      matching,
    ],
  });
  expect(latestPublication(value, matching.postKey, 'post')).toBe(matching);
  expect(
    latestPublication(state({ account: null, publications: [matching] }), matching.postKey, 'post'),
  ).toBeUndefined();
});
it('prevents another upload for active, uncertain, or already published attempts', () => {
  for (const status of ['preparing', 'processing', 'publishing', 'uncertain', 'published'] as const)
    expect(publicationBlocksUpload(publication({ status }))).toBe(true);
  expect(publicationBlocksUpload(publication({ status: 'failed' }))).toBe(false);
  expect(publicationBlocksUpload(undefined)).toBe(false);
});
it('keeps missing metrics distinct from real zero and retains previous values on errors', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsMetrics, {
      publication: publication({
        metrics: { views: 19, likes: 0, replies: null },
        metricsUpdatedAt: '2026-09-28T00:00:00Z',
        metricsProblem: { code: 'offline', message: '다시 조회해야 합니다.' },
      }),
    }),
  );
  expect(html).toContain('<dd>19</dd>');
  expect(html).toContain('<dd>0</dd>');
  expect(html).toContain('<dd>—</dd>');
  expect(html).not.toContain('다시 조회해야 합니다.');
  expect(html).not.toContain('role="alert"');
});
it('keeps statistics controls without listing account posts or metrics', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, {
      threads: ui(
        state({
          publications: [],
          recentPublications: [
            publication({
              text: 'Another library post',
              metrics: { views: 41, likes: 2, replies: 1 },
            }),
          ],
        }),
      ),
      enabled: true,
    }),
  );
  expect(html).not.toContain('Another library post');
  expect(html).not.toContain('threads-insights-list');
  expect(html).not.toContain('threads-metrics');
  expect(html).toMatch(/<button type="button">지금 조회<\/button>/);
  expect(html).not.toContain('이 앱에서 업로드한 게시글이 아직 없습니다.');
});
it('requires only the token and retrieves expiry without a user duration or date field', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, {
      threads: ui(state({ account: null, storageConfigured: false })),
      enabled: true,
    }),
  );
  expect(html).toContain('계정과 실제 만료 일시를 자동으로 확인합니다.');
  const accountArea = html.slice(0, html.indexOf('</section>'));
  expect(accountArea.match(/<input /g)).toHaveLength(1);
  expect(html).not.toMatch(/threads-token-expiry|expires_in|5184000|datetime-local/);
  expect(html).toMatch(/id="threads-access-token"[^>]*type="password"/);
  expect(html).not.toMatch(/AWS|S3|버킷|Access Key|Secret Access Key|threads-storage|\.env/);
});
it('offers reconciliation without a second publish action for an uncertain result', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state({ publications: [publication({ status: 'uncertain', remoteId: null })] })),
    }),
  );
  expect(html).toContain('게시 결과 확인 필요');
  expect(html).toContain('상태 확인');
  expect(html).toContain('게시 결과 연결');
  expect(html).not.toMatch(/<button[^>]*>API 업로드<\/button>/);
});

it('shows revoked credentials as requiring reconnection before the supplied expiry', () => {
  const value = state();
  value.account!.requiresReconnect = true;
  value.recentPublications = [publication()];
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, { threads: ui(value), enabled: true }),
  );
  expect(html).toContain('연결 해제됨 · 토큰 다시 등록 필요');
  expect(html).not.toContain('>연결됨<');
  expect(html).toMatch(/<button type="button" disabled="">지금 조회<\/button>/);
});

it('directs users to file server connection settings for unavailable uploads', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state({ storageConfigured: false })),
    }),
  );
  expect(html).toContain('설정에서 파일 서버 연결 코드를 등록하세요.');
  expect(html).not.toMatch(/AWS|S3|버킷|Access Key|Secret Access Key|\.env/);
});

it('routes an expiry lookup failure to a toast even without a usable account', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, {
      threads: ui(
        state({
          account: null,
          accountProblem: {
            code: 'account_expiry',
            message: '토큰의 만료 정보를 확인하지 못했습니다.',
          },
        }),
      ),
      enabled: true,
    }),
  );
  expect(toastMessage).toHaveBeenCalledExactlyOnceWith(
    '토큰의 만료 정보를 확인하지 못했습니다.',
    true,
  );
  expect(html).not.toContain('토큰의 만료 정보를 확인하지 못했습니다.');
  expect(html).not.toContain('role="alert"');
  expect(html).toMatch(/id="threads-access-token"[^>]*type="password"/);
});

it('routes a repeated token failure once to toast and retains the account retry button', () => {
  const message = '토큰 정보를 조회할 권한이 없습니다.';
  const value = ui(
    state({
      account: null,
      accountProblem: { code: 'account_debug_permission', message },
      problem: { code: 'account_debug_permission', message },
    }),
  );
  value.error = message;
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, { threads: value, enabled: true }),
  );
  const accountArea = html.slice(0, html.indexOf('</section>'));
  expect(toastMessage).toHaveBeenCalledExactlyOnceWith(message, true);
  expect(html).not.toContain(message);
  expect(html).not.toContain('role="alert"');
  expect(accountArea).toContain('연결 상태 다시 확인');
  expect(html).not.toContain('settings-notice error');
});
it('prioritizes the current request failure over a previous account or general problem', () => {
  const value = ui(
    state({
      accountProblem: { code: 'account_request', message: '이전 계정 오류' },
      problem: { code: 'threads_failed', message: '이전 작업 오류' },
    }),
  );
  value.error = '현재 토큰을 확인하지 못했습니다.';
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, { threads: value, enabled: true }),
  );
  expect(toastMessage).toHaveBeenCalledExactlyOnceWith(value.error, true);
  expect(html).not.toContain(value.error);
  expect(html).not.toContain('이전 계정 오류');
  expect(html).not.toContain('이전 작업 오류');
  expect(html).not.toContain('role="alert"');
});

it('routes a statistics failure to toast without exposing saved counts in settings', () => {
  const message = '최근 게시글 통계를 갱신하지 못했습니다.';
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, {
      threads: ui(
        state({
          recentPublications: [
            publication({
              metrics: { views: 7, likes: 2, replies: null },
              metricsProblem: { code: 'network', message },
            }),
          ],
        }),
      ),
      enabled: true,
    }),
  );
  expect(toastMessage).toHaveBeenCalledExactlyOnceWith(message, true);
  expect(html).not.toContain(message);
  expect(html).not.toContain('<dd>7</dd>');
});
it('routes a saved publication problem to toast without removing its recovery controls', () => {
  const message = '게시 결과를 확인해야 합니다.';
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(
        state({
          publications: [
            publication({
              status: 'uncertain',
              remoteId: null,
              problem: { code: 'threads_uncertain', message },
            }),
          ],
        }),
      ),
    }),
  );
  expect(toastMessage).toHaveBeenCalledExactlyOnceWith(message, true);
  expect(html).not.toContain(message);
  expect(html).not.toContain('role="alert"');
  expect(html).toContain('상태 확인');
  expect(html).toContain('게시 결과 연결');
});

it('places a masked file server code input between the Threads account and statistics', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsAccountSettings, {
      threads: ui(state({ account: null, storageConfigured: false })),
      enabled: true,
    }),
  );
  expect(html.indexOf('id="threads-account-title"')).toBeLessThan(
    html.indexOf('id="file-server-title"'),
  );
  expect(html.indexOf('id="file-server-title"')).toBeLessThan(
    html.indexOf('id="threads-insights-title"'),
  );
  expect(html).toMatch(
    /id="file-server-connection-code"[^>]*type="password"[^>]*autoComplete="off"/,
  );
  expect(html).toContain('관리자에게 받은 연결 코드');
  expect(html).toContain('코드의 사용 가능 여부는 파일 업로드 시 확인합니다.');
  expect(html).not.toContain('role="alert"');
});

it('shows only the saved server and code controls without claiming verification or exposing credentials', () => {
  const html = renderToStaticMarkup(
    createElement(FileServerSettings, {
      threads: ui(
        state({
          fileServer: { server: 'https://files.example.test', savedAt: '2026-09-28T00:00:00Z' },
        }),
      ),
      enabled: true,
    }),
  );
  expect(html).toContain('<strong>files.example.test</strong>');
  expect(html).toContain('<span>저장됨</span>');
  expect(html).toContain('코드 교체');
  expect(html).toContain('연결 해제');
  expect(html).not.toContain('연결됨');
  expect(html).not.toContain('<input');
  expect(html).not.toContain('role="alert"');
});

it('blocks file server configuration while disabled, loading, or working', () => {
  for (const [enabled, loading, working] of [
    [false, false, false],
    [true, true, false],
    [true, false, true],
  ]) {
    const threads = { ...ui(state()), loading, working };
    const emptyHtml = renderToStaticMarkup(createElement(FileServerSettings, { threads, enabled }));
    expect(emptyHtml).toMatch(/id="file-server-connection-code"[^>]*disabled=""/);
    threads.state = state({
      fileServer: { server: 'https://files.example.test', savedAt: '2026-09-28T00:00:00Z' },
    });
    const savedHtml = renderToStaticMarkup(createElement(FileServerSettings, { threads, enabled }));
    expect(savedHtml).toMatch(/<button type="button" disabled="">코드 교체<\/button>/);
    expect(savedHtml).toMatch(/<button type="button" disabled="">연결 해제<\/button>/);
  }
});

function registeredPost(): Post {
  const mediaId = 'a'.repeat(32);
  return {
    key: 'source:post',
    account: 'source',
    postId: 'post',
    originalUrl: '',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    caption: 'Original caption',
    captionStatus: 'complete',
    captionObservedAt: null,
    attachmentStatus: 'complete',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: '',
    attachments: [
      {
        mediaId,
        ordinal: 1,
        kind: 'image',
        status: 'saved',
        localUrl: `threads-media://file/${mediaId}`,
        observedAt: null,
        addressStatus: 'http_candidate',
        reason: null,
      },
    ],
    draft: {
      caption: 'Locally revised caption',
      mediaIds: [mediaId],
      createdAt: '2026-09-28T00:00:00Z',
      updatedAt: '2026-09-28T00:02:00Z',
      revision: 2,
    },
  };
}

function renderRegisteredCard(item?: ThreadsPublication, reply?: ThreadsPublication) {
  return renderToStaticMarkup(
    createElement(RegisteredPostCard, {
      post: registeredPost(),
      publication: item,
      replyPublication: reply,
      onChange: () => undefined,
      onOpen: () => undefined,
      onDelete: () => undefined,
      onExport: () => undefined,
      exporting: false,
      actionsDisabled: false,
    }),
  );
}

function renderRegisteredDetail(value: ThreadsState, post = registeredPost()) {
  return renderToStaticMarkup(
    createElement(PostRegistrationModal, {
      post,
      draft: post.draft,
      mode: 'view',
      threads: ui(value),
      onSave: async () => undefined,
      onGenerate: async () => null,
      onCancelGeneration: async () => undefined,
      onClose: () => undefined,
      onSaveComment: async () => undefined,
      onDelete: () => undefined,
      onExport: () => undefined,
    }),
  );
}

it.each([
  ['missing publication', undefined],
  ['preparing', publication({ status: 'preparing', remoteId: null })],
  ['processing', publication({ status: 'processing', remoteId: null })],
  ['publishing', publication({ status: 'publishing', remoteId: null })],
  ['failed', publication({ status: 'failed', remoteId: null })],
  ['uncertain', publication({ status: 'uncertain' })],
  ['reply only', publication({ kind: 'reply' })],
  ['missing remote ID', publication({ remoteId: null })],
  ['empty remote ID', publication({ remoteId: '' })],
] as const)('does not label %s as registration complete', (_label, item) => {
  expect(isPublishedPost(item)).toBe(false);
  expect(renderToStaticMarkup(createElement(ThreadsPublishedBadge, { publication: item }))).toBe(
    '',
  );
  const card = renderRegisteredCard(item);
  expect(card).not.toContain('등록 완료');
  expect(card).not.toContain('post-published-marker');
});

it('marks a successfully published post beside download even after its local draft is edited', () => {
  const item = publication({ draftRevision: 1 });
  expect(isPublishedPost(item)).toBe(true);
  const card = renderRegisteredCard(item);
  expect(card).toContain('Locally revised caption');
  expect(card).toContain('class="post-published-marker"><span class="threads-published-badge"');
  expect(card).toContain('>등록 완료</span>');
  expect(card).toContain('@publisher 계정의 Threads 게시 이력');
  expect(card.indexOf('post-published-marker')).toBeLessThan(card.indexOf('post-export-button'));
});

it('shows the same historical badge in the detail heading even when credentials need reconnecting', () => {
  const value = state({ publications: [publication()], storageConfigured: false });
  value.account!.expiresAt = '2020-01-01T00:00:00Z';
  value.account!.requiresReconnect = true;
  const html = renderRegisteredDetail(value);
  expect(html).toMatch(
    /id="registration-selected-title">등록한 미디어.*?<\/h3><span class="threads-publication-badges"><span class="threads-published-badge"[^>]*>등록 완료<\/span><\/span><\/div>/,
  );
  expect(html).toContain('Locally revised caption');
});

it.each([
  ['another account', state({ publications: [publication({ accountId: '999' })] })],
  ['another post', state({ publications: [publication({ postKey: 'source:another' })] })],
  ['reply only', state({ publications: [publication({ kind: 'reply' })] })],
  ['uncertain result', state({ publications: [publication({ status: 'uncertain' })] })],
  ['account disconnected', state({ account: null, publications: [publication()] })],
  ['account-wide history only', state({ recentPublications: [publication()] })],
] as const)('does not show the detail badge for %s', (_label, value) => {
  const html = renderRegisteredDetail(value);
  expect(html).not.toContain('threads-published-badge');
});

it('separates the API upload heading while preserving upload guidance', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state()),
    }),
  );
  expect(html).toMatch(/<h3[^>]*class="section-divider"[^>]*>API 업로드<\/h3>/);
  expect(html).toContain('아래 API 업로드를 누르면 연결 계정과 등록 내용을 확인한 뒤 게시합니다.');
});

it('shows the publisher once and the daily schedule beside the saved publication time', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state({ publications: [publication()] })),
    }),
  );
  expect(html.match(/@publisher/g)).toHaveLength(1);
  expect(html).toContain('게시글 등록 완료');
  expect(html).toContain('(매일 오전 10시에 자동 갱신됩니다.)');
  expect(html).not.toContain('threads-metrics');
  expect(html).not.toContain('아직 통계를 조회하지 않았습니다.');
});

it('retains previously fetched metrics in the completed publication', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(
        state({
          publications: [
            publication({
              metrics: { views: 25, likes: 3, replies: 1 },
              metricsUpdatedAt: '2026-09-29T01:00:00Z',
            }),
          ],
        }),
      ),
    }),
  );
  expect(html).toContain('<dd>25</dd>');
  expect(html).toContain('<dd>3</dd>');
});

it('locks the detail only for its active publication, not a background insights sync', () => {
  const progress = {
    postKey: 'source:post',
    kind: 'post' as const,
    stage: 'uploading' as const,
    mediaKind: 'video' as const,
    current: 1,
    total: 2,
  };
  const html = renderRegisteredDetail(state({ busy: true, publishProgress: progress }));
  expect(html).toContain('threads-upload-overlay');
  expect(html).toContain('영상 업로드 중');
  expect(html).toMatch(/class="modal-header" inert=""/);
  expect(html).toMatch(/class="registration-form" inert=""/);
  const syncing = renderRegisteredDetail(state({ busy: true, syncing: true }));
  expect(syncing).not.toContain('threads-upload-overlay');
  expect(syncing).not.toContain('inert=""');
  const otherPost = renderRegisteredDetail(
    state({ busy: true, publishProgress: { ...progress, postKey: 'other' } }),
  );
  expect(otherPost).not.toContain('threads-upload-overlay');
});

function publishedReply(overrides: Partial<ThreadsPublication> = {}): ThreadsPublication {
  return publication({
    id: 'reply',
    kind: 'reply',
    remoteId: '789',
    commentUpdatedAt: '2026-09-28T00:00:00Z',
    ...overrides,
  });
}

it.each([
  ['local comment only', undefined],
  ['preparing', publishedReply({ status: 'preparing', remoteId: null })],
  ['processing', publishedReply({ status: 'processing', remoteId: null })],
  ['publishing', publishedReply({ status: 'publishing', remoteId: null })],
  ['failed', publishedReply({ status: 'failed', remoteId: null })],
  ['uncertain', publishedReply({ status: 'uncertain' })],
  ['post instead of reply', publication()],
  ['missing remote ID', publishedReply({ remoteId: null })],
  ['empty remote ID', publishedReply({ remoteId: '' })],
  ['another account', publishedReply({ accountId: '999' })],
  ['another post', publishedReply({ postKey: 'source:another' })],
] as const)('does not mark %s as a completed comment', (_label, reply) => {
  const parent = publication();
  expect(isPublishedReply(reply, parent)).toBe(false);
  expect(
    renderToStaticMarkup(
      createElement(ThreadsReplyPublishedBadge, {
        reply,
        publication: parent,
      }),
    ),
  ).toBe('');
  const card = renderRegisteredCard(parent, reply);
  expect(card).toContain('>등록 완료</span>');
  expect(card).not.toContain('댓글 완료');
});

it('requires a successfully published parent before showing a completed reply', () => {
  for (const parent of [
    undefined,
    publication({ status: 'uncertain' }),
    publication({ remoteId: null }),
    publishedReply(),
  ]) {
    expect(isPublishedReply(publishedReply(), parent)).toBe(false);
    expect(renderRegisteredCard(parent, publishedReply())).not.toContain('댓글 완료');
  }
});

it('places completed reply badges immediately after the completed post on cards and details', () => {
  const parent = publication();
  const reply = publishedReply();
  const card = renderRegisteredCard(parent, reply);
  const detail = renderRegisteredDetail(state({ publications: [parent, reply] }));
  const consecutiveBadges =
    /class="threads-published-badge"[^>]*>등록 완료<\/span><span class="threads-published-badge threads-reply-published-badge"[^>]*>댓글 완료<\/span>/;
  expect(isPublishedReply(reply, parent)).toBe(true);
  expect(card).toMatch(consecutiveBadges);
  expect(detail).toMatch(consecutiveBadges);
  expect(detail).toMatch(
    /id="registration-selected-title">등록한 미디어.*?<\/h3><span class="threads-publication-badges">/,
  );
});

it('keeps the published reply badge after local comment edits and distinguishes its completed button', () => {
  const post = registeredPost();
  post.comment = {
    caption: 'Edited after the reply was published',
    link: '',
    updatedAt: '2026-09-28T00:03:00Z',
  };
  const detail = renderRegisteredDetail(
    state({ publications: [publication(), publishedReply()] }),
    post,
  );
  expect(detail).toContain('threads-reply-published-badge');
  expect(detail).toContain('Edited after the reply was published');
  expect(detail).toMatch(
    /<button[^>]*disabled=""[^>]*aria-label="댓글 API 업로드"[^>]*>.*?댓글 완료<\/button>/,
  );
});

it('does not show a completed reply for a saved comment or an unrelated account publication', () => {
  const post = registeredPost();
  post.comment = { caption: 'Saved locally only', link: '', updatedAt: '2026-09-28T00:03:00Z' };
  for (const publications of [
    [publication()],
    [publication(), publishedReply({ accountId: '999' })],
    [publication(), publishedReply({ postKey: 'source:another' })],
    [publication(), publishedReply({ status: 'uncertain' })],
  ]) {
    const detail = renderRegisteredDetail(state({ publications }), post);
    expect(detail).not.toContain('threads-reply-published-badge');
    expect(detail).not.toContain('댓글 완료');
  }
});

it('describes text reply progress without claiming to upload or process attachments', () => {
  for (const [stage, title] of [
    ['checking', '댓글 정보 확인 중'],
    ['preparing', '댓글 게시 준비 중'],
    ['processing', 'Threads에서 댓글 처리 중'],
  ] as const) {
    const progress = {
      postKey: 'source:post',
      kind: 'reply' as const,
      stage,
      current: 1,
      total: 2,
      mediaKind: 'video' as const,
    };
    expect(threadsUploadLabel(progress)).toBe(title);
    const html = renderToStaticMarkup(createElement(ThreadsUploadOverlay, { progress }));
    expect(html).toContain('Threads 댓글 게시 진행');
    expect(html).toContain(title);
    expect(html).not.toMatch(/첨부|이미지|영상|미디어/);
  }
  const detail = renderRegisteredDetail(
    state({
      busy: true,
      publishProgress: { postKey: 'source:post', kind: 'reply', stage: 'publishing' },
      publications: [publication()],
    }),
  );
  expect(detail).toContain('Threads에 댓글 게시 중');
  expect(detail).toMatch(/class="modal-header" inert=""/);
  expect(detail).toMatch(/class="registration-form" inert=""/);
});

it('makes completed post and reply IDs buttons for opening the actual publication', () => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state({ publications: [publication(), publishedReply()] })),
    }),
  );
  expect(html.match(/class="threads-publication-link"/g)).toHaveLength(2);
  expect(html).toMatch(/aria-label="게시글 456 기본 브라우저에서 열기"[^>]*>456<\/button>/);
  expect(html).toMatch(/aria-label="댓글 789 기본 브라우저에서 열기"[^>]*>789<\/button>/);
  expect(html).not.toContain('href=');
});

it.each(['preparing', 'processing', 'publishing', 'failed', 'uncertain'] as const)(
  'leaves a %s result ID as plain text',
  (status) => {
    const html = renderToStaticMarkup(
      createElement(ThreadsPublicationPanel, {
        postKey: 'source:post',
        threads: ui(state({ publications: [publication({ status })] })),
      }),
    );
    expect(html).toContain('게시 ID: 456');
    expect(html).not.toContain('threads-publication-link');
  },
);

it.each([null, ''])('omits a publication link when the remote ID is %s', (remoteId) => {
  const html = renderToStaticMarkup(
    createElement(ThreadsPublicationPanel, {
      postKey: 'source:post',
      threads: ui(state({ publications: [publication({ remoteId })] })),
    }),
  );
  expect(html).not.toContain('게시 ID:');
  expect(html).not.toContain('threads-publication-link');
});

it('disables publication links during other work or when the account requires reconnecting', () => {
  for (const condition of ['disabled', 'loading', 'working', 'expired', 'reconnect']) {
    const value = state({ publications: [publication(), publishedReply()] });
    if (condition === 'expired') value.account!.expiresAt = '2020-01-01T00:00:00Z';
    if (condition === 'reconnect') value.account!.requiresReconnect = true;
    const threads = {
      ...ui(value),
      loading: condition === 'loading',
      working: condition === 'working',
    };
    const html = renderToStaticMarkup(
      createElement(ThreadsPublicationPanel, {
        postKey: 'source:post',
        threads,
        disabled: condition === 'disabled',
      }),
    );
    expect(html.match(/class="threads-publication-link" disabled=""/g)).toHaveLength(2);
  }
});
