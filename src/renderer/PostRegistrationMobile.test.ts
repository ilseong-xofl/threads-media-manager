import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import { PostRegistrationModal } from './PostRegistrationModal';
import { useMobilePublications } from './use-mobile-publications';
import { useManagedThreads } from './use-managed-threads';
import { useDraftNote } from './use-draft-note';
import type { DraftNote, Post } from '../shared/contracts';
import type { DailyPersona } from '../shared/daily';
import type { MobilePublication, PendingMobilePublication } from '../shared/mobile-publications';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import type { ThreadsUi } from './use-threads-api';

vi.mock('./use-mobile-publications', () => ({ useMobilePublications: vi.fn() }));
vi.mock('./use-managed-threads', () => ({ useManagedThreads: vi.fn() }));
vi.mock('./use-draft-note', () => ({ useDraftNote: vi.fn() }));

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
  pendingReason: null,
  pendingDeletion: false,
  lastCheck: null,
  account: {
    id: publication.accountId,
    ownerId: 'owner-one',
    registrationId: 'registration-one',
    appName: '테스트 앱',
    label: 'test_account',
    appId: null,
    threadsUserId: null,
    validationStatus: 'pending_validation',
    tokenRevision: 1,
    expiresAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
};
function mock(
  publications: MobilePublication[] = [],
  pending: PendingMobilePublication[] = [],
  accounts: ManagedThreadsAccountRow[] = [account],
  {
    note = { accountId: account.account!.id, translation: null, commentTranslation: null },
    noteLoaded = true,
    loaded = true,
    failed = false,
  }: { note?: DraftNote; noteLoaded?: boolean; loaded?: boolean; failed?: boolean } = {},
) {
  vi.mocked(useDraftNote).mockReturnValue({ note, loaded: noteLoaded, reload: vi.fn() });
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
    loaded,
    failed,
    busy: false,
    cooldownUntil: 0,
    refreshWindowDays: 14,
    getSnapshot: vi.fn(),
    subscribe: vi.fn(),
    setEnabled: vi.fn(),
    synchronize: vi.fn(),
    register: vi.fn(),
    replace: vi.fn(),
    update: vi.fn(),
    recheck: vi.fn(),
    refreshToken: vi.fn(),
    remove: vi.fn(),
    retry: vi.fn(),
  });
}
function render(
  threads?: ThreadsUi,
  extra: Partial<Parameters<typeof PostRegistrationModal>[0]> = {},
) {
  return renderToStaticMarkup(
    createElement(PostRegistrationModal, {
      post,
      draft: post.draft,
      threads,
      personasLoaded: true,
      ...extra,
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

const second: ManagedThreadsAccountRow = {
  ...account,
  localId: 'local-two',
  appName: '둘째 앱',
  label: 'second_account',
  account: { ...account.account!, id: 'account-two', createdAt: '2026-10-20T00:00:00.000Z' },
};
const persona: DailyPersona = {
  id: 'persona-one',
  name: '하루',
  accountId: 'account-two',
  language: 'en',
  description: '직업: 간호사\n이모지: 1개',
  createdAt: '2026-11-01T00:00:00.000Z',
};
const noNote: DraftNote = { accountId: null, translation: null, commentTranslation: null };
function primaryButton(html: string, label: string) {
  const button = html
    .match(/<button\b[^>]*>[\s\S]*?<\/button>/g)
    ?.find((element) => element.includes('class="primary"') && element.includes(label));
  expect(button).toBeDefined();
  return button!;
}

it('shows the account and its current persona at the top of a registered post', () => {
  mock([], [], [account, second], {
    note: { accountId: 'account-two', translation: '저장된 본문의 뜻', commentTranslation: null },
  });
  const html = render(undefined, { personas: [persona] });
  expect(html.indexOf('registration-account-title')).toBeLessThan(
    html.indexOf('registration-selected-title'),
  );
  expect(html).toContain('둘째 앱 · @second_account');
  expect(html).toContain('현재 페르소나');
  expect(html).toContain('하루');
  expect(html).toContain('영어');
  expect(html).toContain('직업: 간호사 · 이모지: 1개');
  expect(html).toContain('저장된 본문의 뜻');
  expect(html).not.toContain('자동 지정');
  expect(html).not.toContain('<select');
});

it('marks an older post without a recorded account as auto-assigned to the first account', () => {
  mock([], [], [second, account], { note: noNote });
  const html = render();
  expect(html).toContain('자동 지정');
  expect(html).toContain('이 글은 계정을 고른 적이 없어 첫 번째 계정으로 표시합니다.');
  expect(html).toContain('테스트 앱 · @test_account');
  expect(html).toContain('이 계정에는 페르소나가 없습니다.');
  expect(sendButton()).not.toContain('disabled=""');
});

it('places the account select between the selected media and the caption while editing', () => {
  mock([], [], [account, second], { note: noNote });
  const html = render(undefined, { mode: 'edit', personas: [persona] });
  const selectedAt = html.indexOf('registration-selected-title');
  const accountAt = html.indexOf('registration-account-title');
  expect(selectedAt).toBeLessThan(accountAt);
  expect(accountAt).toBeLessThan(html.indexOf('registration-caption-title'));
  expect(html).toContain('aria-label="이 글을 올릴 계정"');
  expect(html).toContain('둘째 앱 · @second_account — 하루</option>');
  expect(html).toContain('aria-label="AI 캡션 언어"');
});

it('fixes the caption language to the persona of the chosen account', () => {
  mock([], [], [second], { note: { ...noNote, accountId: 'account-two' } });
  const html = render(undefined, { mode: 'edit', personas: [persona] });
  expect(html).toContain('페르소나 언어: 영어');
  expect(html).not.toContain('aria-label="AI 캡션 언어"');
  expect(html).toContain('페르소나와 원본 캡션을 합쳐');
  expect(html).toContain('첫 번째 이미지 한 장');
});

it('shows only suggestions written for the current account and persona, with their Korean', () => {
  mock([], [], [second], { note: { ...noNote, accountId: 'account-two' } });
  const suggestions = {
    language: 'en' as const,
    context: JSON.stringify(['account-two', 'persona-one', 'en', persona.description]),
    captions: ['one', 'two', 'three'],
    translations: ['하나', '둘', '셋'],
  };
  const html = render(undefined, {
    mode: 'edit',
    personas: [persona],
    initialSuggestions: suggestions,
  });
  expect(html).toContain('aria-label="AI 캡션 제안"');
  expect(html).toContain('<p class="registration-translation">둘</p>');
  const other = render(undefined, {
    mode: 'edit',
    personas: [{ ...persona, description: '직업: 교사' }],
    initialSuggestions: suggestions,
  });
  expect(other).not.toContain('aria-label="AI 캡션 제안"');
});

it('locks the account of a sent post and blocks sending when that account is gone', () => {
  const cancelledUnknown = {
    ...publication,
    accountId: 'account-gone',
    status: 'cancelled' as const,
    rootStatus: 'unknown',
  };
  mock([cancelledUnknown], [], [account], { note: noNote });
  const html = render(undefined, { mode: 'edit' });
  expect(html).toContain('이미 보낸 글이라 계정을 바꿀 수 없습니다.');
  expect(html).not.toContain('다른 계정을 고르세요');
  expect(html).toMatch(/<select aria-label="이 글을 올릴 계정"[^>]*disabled=""/);
  expect(primaryButton(html, '변경 저장')).toContain('disabled=""');
  mock([cancelledUnknown], [], [account], { note: noNote });
  const view = render();
  expect(view).toContain('이미 보낸 글이라 계정을 바꿀 수 없습니다.');
  expect(sendButton()).toContain('disabled=""');
  expect(sendButton()).toContain('이미 보낸 글이라 계정을 바꿀 수 없습니다.');
});

it('asks for another account when the recorded one is gone from an unsent post', () => {
  mock([], [], [account], { note: { ...noNote, accountId: 'account-gone' } });
  expect(render()).toContain('수정에서 다른 계정을 고르세요.');
  expect(sendButton()).toContain('disabled=""');
  const html = render(undefined, { mode: 'edit' });
  expect(html).toContain('다른 계정을 고르세요.');
  expect(html).toContain('(찾을 수 없음)');
  expect(html).not.toMatch(/<select aria-label="이 글을 올릴 계정"[^>]*disabled=""/);
  expect(primaryButton(html, '변경 저장')).toContain('disabled=""');
});

it('tells loading, a failed account read and no accounts apart', () => {
  mock([], [], [], { loaded: false });
  const loading = render(undefined, { mode: 'edit' });
  expect(loading).toContain('계정을 확인하고 있습니다');
  expect(primaryButton(loading, '변경 저장')).toContain('disabled=""');

  mock([], [], [], { note: noNote, noteLoaded: false });
  expect(render()).toContain('계정을 확인하고 있습니다');
  expect(sendButton()).toContain('disabled=""');

  mock([], [], [], { failed: true });
  const failed = render();
  expect(failed).toContain('계정 목록을 불러오지 못했습니다');
  expect(failed).toContain('다시 시도');
  expect(failed).not.toContain('사용할 Threads 계정이 없습니다');

  mock([], [], [], { note: noNote });
  const none = render();
  expect(none).toContain('사용할 Threads 계정이 없습니다');
  expect(none).toContain('[계정 관리]에서 [계정 추가]');
});

it('blocks writing a new post until an account exists', () => {
  mock([], [], [], { note: noNote });
  const html = render(undefined, { draft: undefined, mode: 'edit' });
  expect(html).toContain('사용할 Threads 계정이 없습니다');
  expect(html).toMatch(/<textarea id="registration-caption"[^>]*disabled=""/);
  expect(html).toMatch(/class="registration-source-item"[^>]*disabled=""/);
  expect(primaryButton(html, '등록')).toContain('disabled=""');
  mock([], [], [account], { note: noNote });
  const ready = render(undefined, { draft: undefined, mode: 'edit' });
  expect(ready).not.toContain('자동 지정');
  expect(ready).not.toMatch(/<textarea id="registration-caption"[^>]*disabled=""/);
});

it('shows the stored Korean under the saved comment', () => {
  mock([], [], [account], {
    note: { accountId: 'account-one', translation: null, commentTranslation: '댓글의 뜻' },
  });
  expect(render()).toContain('<p class="registration-translation">댓글의 뜻</p>');
});
