import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { PostRegistrationModal } from './PostRegistrationModal';
import { useMobilePublications } from './use-mobile-publications';
import { useManagedThreads } from './use-managed-threads';
import type { Post } from '../shared/contracts';
import type { MobilePublication, PendingMobilePublication } from '../shared/mobile-publications';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import type { ThreadsUi } from './use-threads-api';

vi.mock('./use-mobile-publications', () => ({ useMobilePublications: vi.fn() }));
vi.mock('./use-managed-threads', () => ({ useManagedThreads: vi.fn() }));

const mediaId = 'a'.repeat(32);
const post: Post = {
  key: 'sample:post',
  account: 'sample',
  postId: 'post',
  originalUrl: '',
  publishedAt: null,
  collectedAt: null,
  observedAt: null,
  caption: '원문',
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
    caption: '저장된 본문',
    mediaIds: [mediaId],
    revision: 2,
    createdAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T01:00:00.000Z',
  },
  comment: { caption: '저장된 댓글', link: '', updatedAt: '2026-10-19T01:00:00.000Z' },
};
const publication: MobilePublication = {
  id: 'pub-one',
  requestId: 'request-one',
  version: 1,
  accountId: 'account-one',
  source: {
    libraryId: 'library-one',
    postKey: post.key,
    draftCreatedAt: post.draft!.createdAt,
    draftRevision: 2,
    commentUpdatedAt: post.comment!.updatedAt,
  },
  status: 'ready',
  caption: post.draft!.caption,
  comment: null,
  media: [],
  sentAt: '2026-10-19T01:00:00.000Z',
  deadlineAt: '2026-10-21T01:00:00.000Z',
  rootStatus: 'queued',
  commentStatus: 'none',
};
const account: ManagedThreadsAccountRow = {
  localId: 'local-one',
  registrationId: 'registration-one',
  appName: '테스트 앱',
  label: 'test_account',
  appId: null,
  localRevision: 1,
  localState: 'synced',
  pendingAction: null,
  pendingDeletion: false,
  account: {
    id: publication.accountId,
    ownerId: 'owner-one',
    registrationId: 'registration-one',
    appName: '테스트 앱',
    label: 'test_account',
    appId: null,
    threadsUserId: null,
    validationStatus: 'pending_validation',
    appIdVerified: false,
    tokenRevision: 1,
    expiresAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
};
function mock(
  publications: MobilePublication[] = [],
  pending: PendingMobilePublication[] = [],
  accounts: ManagedThreadsAccountRow[] = [account],
) {
  vi.mocked(useMobilePublications).mockReturnValue({
    publications,
    pending,
    loaded: true,
    busy: false,
    working: false,
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    setContext: vi.fn(),
    synchronize: vi.fn(),
    send: vi.fn(),
    retry: vi.fn(),
    recall: vi.fn(),
    cancelPending: vi.fn(),
  });
  vi.mocked(useManagedThreads).mockReturnValue({
    accounts,
    loaded: true,
    busy: false,
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    setEnabled: vi.fn(),
    synchronize: vi.fn(),
    register: vi.fn(),
    replace: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
    discard: vi.fn(),
  });
}
function render(threads?: ThreadsUi) {
  return renderToStaticMarkup(
    createElement(PostRegistrationModal, {
      post,
      draft: post.draft,
      threads,
      onSave: vi.fn(),
      onGenerate: vi.fn(),
      onCancelGeneration: vi.fn(),
      onClose: vi.fn(),
      onSaveComment: vi.fn(),
      onDelete: vi.fn(),
      onExport: vi.fn(),
    }),
  );
}
beforeEach(() => mock());

function sendButton() {
  const button = render()
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((element) => element.includes('모바일로 보내기'));
  expect(button).toBeDefined();
  return button!;
}

it('disables mobile send when no registered account is available', () => {
  for (const accounts of [
    [],
    [{ ...account, account: null }],
    [{ ...account, pendingDeletion: true }],
  ]) {
    mock([], [], accounts);
    expect(sendButton()).toContain('disabled=""');
  }
  mock();
  expect(sendButton()).not.toContain('disabled=""');
});

it('disables a second send while a snapshot is uploading or ready, then enables it after recall or expiry', () => {
  expect(sendButton()).not.toContain('disabled=""');
  for (const status of ['uploading', 'ready'] as const) {
    mock([{ ...publication, status }]);
    expect(sendButton()).toContain('disabled=""');
    expect(sendButton()).toContain('먼저 게시 대기를 회수');
  }
  for (const status of ['cancelled', 'expired'] as const) {
    mock([{ ...publication, status }]);
    expect(sendButton()).not.toContain('disabled=""');
  }
});

it('keeps sending disabled until a pending transmission is resolved', () => {
  mock(
    [],
    [{ requestId: 'pending', accountId: publication.accountId, source: publication.source }],
  );
  expect(sendButton()).toContain('disabled=""');
  expect(sendButton()).toContain('보류된 전송을 취소');
  mock();
  expect(sendButton()).not.toContain('disabled=""');
});

it('keeps ZIP download and local delete while replacing desktop publish with mobile send', () => {
  const html = render();
  expect(html).toContain('모바일로 보내기');
  expect(html).toContain('등록 게시글 ZIP 다운로드');
  expect(html).toContain('등록 게시글 삭제');
  expect(html).not.toContain('API 업로드');
  expect(html).not.toContain('모바일 게시 준비 중');
  expect(html).not.toContain('기존 PC 게시 이력');
});

it('blocks body editing until recall but keeps the reply editable, and keeps local delete available', () => {
  mock([publication]);
  const html = render();
  expect(html).toContain('먼저 게시 대기를 회수');
  expect(html).toContain('댓글은 수정하면 휴대폰 등록본에도 함께 반영됩니다.');
  expect(html).toContain('class="primary" disabled=""><svg');
  expect(html).toContain('aria-label="댓글 정보 수정"');
  expect(html).not.toContain('disabled="" aria-label="댓글 정보 수정"');
  expect(html).not.toContain('class="registration-delete-button" disabled=""');
  expect(html).toContain('게시 대기 회수');
});

it('locks the reply once the phone has posted it', () => {
  mock([
    { ...publication, status: 'published', rootStatus: 'published', commentStatus: 'published' },
  ]);
  const html = render();
  expect(html).toContain('disabled="" aria-label="댓글 정보 수정"');
  expect(html).toContain('휴대폰에서 이미 등록했거나 등록 중인 댓글은 수정할 수 없습니다.');
});

it('preserves legacy success history separately without enabling desktop publication', () => {
  const html = render({
    loading: false,
    working: false,
    error: null,
    refresh: vi.fn(),
    run: vi.fn(),
    state: {
      desktopRequestsDisabled: true,
      account: {
        id: 'old-account',
        username: 'old_name',
        connectedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-12-01T00:00:00.000Z',
        lastRefreshedAt: null,
        lastRefreshAttemptAt: null,
      },
      accountProblem: null,
      storageConfigured: false,
      fileServer: null,
      publications: [
        {
          id: 'old-pub',
          postKey: post.key,
          accountId: 'old-account',
          username: 'old_name',
          kind: 'post',
          text: '과거 본문',
          draftRevision: 1,
          commentUpdatedAt: null,
          status: 'published',
          remoteId: '1234',
          createdAt: '2026-10-01T00:00:00.000Z',
          publishedAt: '2026-10-01T00:00:00.000Z',
          metrics: null,
          metricsUpdatedAt: null,
          problem: null,
          metricsProblem: null,
        },
      ],
      recentPublications: [],
      busy: false,
      syncing: false,
      lastSyncAt: null,
      problem: null,
    },
  });
  expect(html).toContain('기존 PC 게시 이력');
  expect(html).toContain('@old_name');
  expect(html).toContain('모바일로 보내기');
  expect(html).not.toContain('API 업로드');
});
