import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import type { MobilePublication } from '../shared/mobile-publications';
import { MobilePublicationPanel, MobilePublicationSendDialog } from './MobilePublicationPanel';
import {
  mobileAccountChoices,
  mobilePublicationAccountLabel,
  mobilePublicationCanRecall,
  mobilePublicationLocksEditing,
} from './mobile-publication-model';
import type { MobilePublicationsUi } from './use-mobile-publications';
import { PostCommentSection } from './PostCommentSection';
import type { Post } from '../shared/contracts';

const row: ManagedThreadsAccountRow = {
  localId: 'local-one',
  registrationId: 'registration-one',
  appName: '뷰티 앱',
  label: 'beauty_one',
  appId: null,
  localRevision: 1,
  localState: 'synced',
  pendingAction: null,
  pendingDeletion: false,
  account: {
    id: 'account-one',
    ownerId: 'owner-one',
    registrationId: 'registration-one',
    appName: '뷰티 앱',
    label: 'beauty_one',
    appId: null,
    threadsUserId: null,
    validationStatus: 'pending_validation',
    appIdVerified: false,
    tokenRevision: 1,
    expiresAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
};
const publication: MobilePublication = {
  id: 'publication-one',
  requestId: 'request-one',
  version: 1,
  accountId: 'account-one',
  source: {
    libraryId: 'library-one',
    postKey: 'post-one',
    draftCreatedAt: '2026-10-19T00:00:00.000Z',
    draftRevision: 2,
    commentUpdatedAt: null,
  },
  status: 'ready',
  caption: 'caption',
  comment: { caption: 'comment', link: '' },
  media: [],
  sentAt: '2026-10-19T01:00:00.000Z',
  deadlineAt: '2026-10-21T01:00:00.000Z',
  rootStatus: 'queued',
  commentStatus: 'queued',
};
function mobile(publications: MobilePublication[] = [publication]): MobilePublicationsUi {
  return {
    publications,
    pending: [],
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
  };
}
function renderPanel(state: MobilePublicationsUi) {
  return renderToStaticMarkup(
    createElement(MobilePublicationPanel, { mobile: state, accounts: [row], disabled: false }),
  );
}

describe('mobile publication presentation', () => {
  it('selects the only account by default and warns when sending a new snapshot from an old post', () => {
    const html = renderToStaticMarkup(
      createElement(MobilePublicationSendDialog, {
        accounts: [row],
        busy: false,
        mediaCount: 3,
        includesComment: true,
        hasHistory: true,
        onSend: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('<dialog');
    expect(html).toContain(
      '<option value="account-one" selected="">뷰티 앱 · @beauty_one</option>',
    );
    expect(html).toContain('뷰티 앱 · @beauty_one');
    expect(html).toContain('미디어 3개를 선택한 순서대로');
    expect(html).toContain('준비한 댓글도 함께');
    expect(html).toContain('이전 전송 또는 게시 이력');
    expect(html).toContain('선택한 계정으로 보내기');
    expect(html).not.toContain('class="primary" disabled=""');
    expect(html).toContain('전송 완료 후 게시 기한은 7일입니다.');
    expect(html).not.toContain('multiple');
    expect(html).not.toContain('토큰');
  });

  it('sorts accounts by registration time and selects the oldest without reordering the source', () => {
    const newer = {
      ...row,
      localId: 'local-newer',
      appName: '새 앱',
      label: 'new_account',
      account: { ...row.account!, id: 'account-newer', createdAt: '2026-10-20T00:00:00.000Z' },
    };
    const accounts = [newer, row];
    const html = renderToStaticMarkup(
      createElement(MobilePublicationSendDialog, {
        accounts,
        busy: false,
        mediaCount: 1,
        includesComment: false,
        hasHistory: false,
        onSend: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(mobileAccountChoices(accounts)).toEqual([row, newer]);
    expect(accounts).toEqual([newer, row]);
    expect(html).toContain('<option value="account-one" selected="">');
    expect(html.indexOf('value="account-one"')).toBeLessThan(html.indexOf('value="account-newer"'));
  });

  it('disables sending and the selector when there are no registered accounts', () => {
    const html = renderToStaticMarkup(
      createElement(MobilePublicationSendDialog, {
        accounts: [],
        busy: false,
        mediaCount: 1,
        includesComment: false,
        hasHistory: false,
        onSend: vi.fn(),
        onClose: vi.fn(),
      }),
    );
    expect(html).toContain('<select id="mobile-publication-account" disabled="">');
    expect(html).toContain('등록된 계정이 없습니다');
    expect(html).toContain('class="primary" disabled=""');
  });

  it('allows server-registered unvalidated accounts, but excludes local-only and pending deletion rows', () => {
    expect(
      mobileAccountChoices([
        row,
        { ...row, localId: 'unsynced', account: null },
        { ...row, localId: 'deleting', pendingDeletion: true },
      ]),
    ).toEqual([row]);
    expect(mobilePublicationAccountLabel('missing', [row])).toBe('이전에 연결한 계정');
  });

  it('keeps ready deadlines distinct from a successful Threads publication', () => {
    const html = renderPanel(mobile());
    expect(html).toContain('모바일 게시 대기');
    expect(html).toContain('게시 기한');
    expect(html).toContain('게시 대기 회수');
    expect(html).not.toContain('원글 게시 완료');
    expect(html).not.toContain('계정 중지');
    expect(html).not.toContain('이관');
  });

  it('does not keep a deadline or recall action on a completed publication', () => {
    const html = renderPanel(
      mobile([{ ...publication, status: 'published', rootStatus: 'published' }]),
    );
    expect(html).toContain('원글 게시 완료');
    expect(html).not.toContain('게시 기한');
    expect(html).not.toContain('게시 대기 회수');
  });

  it('shows a server-reported unknown result without offering a recall or new publish action', () => {
    const html = renderPanel(
      mobile([{ ...publication, status: 'started', rootStatus: 'unknown' }]),
    );
    expect(html).toContain('게시 결과 확인 필요');
    expect(html).not.toContain('게시 대기 회수');
    expect(html).not.toContain('원글 게시 완료');
  });

  it('locks editing only for unsent/ready work, and preserves started or uncertain snapshots without recall', () => {
    expect(mobilePublicationLocksEditing([publication], [])).toBe(true);
    expect(mobilePublicationLocksEditing([{ ...publication, status: 'uploading' }], [])).toBe(true);
    expect(
      mobilePublicationLocksEditing(
        [],
        [{ requestId: 'pending', accountId: row.account!.id, source: publication.source }],
      ),
    ).toBe(true);
    for (const status of ['started', 'published', 'cancelled', 'expired'] as const) {
      const record = { ...publication, status, rootStatus: 'uncertain' };
      expect(mobilePublicationLocksEditing([record], [])).toBe(false);
      expect(mobilePublicationCanRecall(record)).toBe(false);
    }
  });

  it('keeps explicit resume and cancellation controls for ambiguous sends', () => {
    const html = renderPanel({
      ...mobile([]),
      pending: [{ requestId: 'pending', accountId: row.account!.id, source: publication.source }],
    });
    expect(html).toContain('전송 재시도');
    expect(html).toContain('전송 취소');
    expect(html).toContain('같은 전송을 이어서');
  });

  it('keeps the mobile comment instruction and removes the desktop comment publish control', () => {
    const html = renderToStaticMarkup(
      createElement(PostCommentSection, {
        post: {
          key: 'post-one',
          comment: { caption: 'comment', link: '', updatedAt: '2026-10-19T00:00:00.000Z' },
        } as Post,
        editing: false,
        onEditingChange: vi.fn(),
        disabled: false,
        saving: false,
        onSave: vi.fn(),
        mobilePublication: true,
      }),
    );
    expect(html).toContain('휴대폰에서 원글 게시 후 별도로 게시');
    expect(html).toContain('댓글 정보 수정');
    expect(html).not.toContain('API 업로드');
  });
});
