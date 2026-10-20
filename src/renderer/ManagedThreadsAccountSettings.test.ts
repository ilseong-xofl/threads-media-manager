import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import {
  ManagedThreadsAccountSettings,
  ManagedThreadsAccountFields,
  ManagedThreadsAccountTable,
  ManagedThreadsDeleteConfirmation,
  managedThreadsActionAvailability,
  managedThreadsInputProblem,
  managedThreadsNameProblem,
} from './ManagedThreadsAccountSettings';
import { useManagedThreads } from './use-managed-threads';

vi.mock('./use-managed-threads', () => ({ useManagedThreads: vi.fn() }));
const server = {
  id: 'server-1',
  ownerId: 'owner-1',
  label: '뷰티 계정',
  appName: '뷰티 마케팅 앱',
  registrationId: 'registration-1',
  appId: null,
  threadsUserId: null,
  validationStatus: 'pending_validation' as const,
  appIdVerified: false,
  tokenRevision: 1,
  expiresAt: null,
  createdAt: '2026-10-19T00:00:00.000Z',
};
const row: ManagedThreadsAccountRow = {
  localId: 'local-1',
  label: '뷰티 계정',
  appName: '뷰티 마케팅 앱',
  registrationId: 'registration-1',
  appId: null,
  account: server,
  localRevision: 1,
  localState: 'synced',
  pendingAction: null,
  pendingDeletion: false,
};
function mock(rows: ManagedThreadsAccountRow[] = [], busy = false, loaded = true) {
  vi.mocked(useManagedThreads).mockReturnValue({
    accounts: rows,
    busy,
    loaded,
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
function render(enabled = true) {
  return renderToStaticMarkup(createElement(ManagedThreadsAccountSettings, { enabled }));
}
beforeEach(() => {
  mock();
});

it('distinguishes local synchronization from mobile validation', () => {
  mock([row]);
  const html = render();
  expect(html).toContain('서버와 동기화됨');
  expect(html).toContain('휴대폰 확인 대기');
  expect(html).toContain('토큰 확인·갱신은 휴대폰에서 직접');
  expect(html).toContain('토큰 교체');
  expect(html).not.toContain('지금 조회');
  expect(html).not.toContain('자동 갱신');
  expect(html).toContain('뷰티 마케팅 앱');
  expect(html).toContain('앱 이름은 구분용입니다.');
  expect(html).not.toContain('Meta App ID');
});

it('accepts app names including Korean and reports the field that needs correction', () => {
  const input = { appName: '  뷰티 마케팅 앱 🌸  ', label: '계정 이름', token: 'synthetic-token' };
  expect(managedThreadsInputProblem(input, true)).toBeNull();
  expect(managedThreadsInputProblem({ ...input, appName: 'seunghun6235' }, true)).toBeNull();
  expect(managedThreadsInputProblem({ ...input, appName: ' ' }, true)).toContain('Meta 앱 이름');
  expect(managedThreadsInputProblem({ ...input, label: ' ' }, true)).toContain('Threads 계정 이름');
  expect(managedThreadsInputProblem({ ...input, appName: '가'.repeat(81) }, true)).toContain(
    '1~80자',
  );
  expect(managedThreadsInputProblem({ ...input, token: 'broken\ntoken' }, true)).toContain(
    '장기 토큰',
  );
  expect(managedThreadsInputProblem({ ...input, appName: '', label: '' }, false)).toBeNull();
});

it('renders app name, Threads account name, and masked token in order without a numeric-only input', () => {
  const html = renderToStaticMarkup(
    createElement(ManagedThreadsAccountFields, {
      id: 'registration',
      appName: '뷰티 앱',
      label: '뷰티 계정',
      token: '',
      registering: true,
      disabled: false,
      onAppNameChange: vi.fn(),
      onLabelChange: vi.fn(),
      onTokenChange: vi.fn(),
    }),
  );
  expect(html.indexOf('Meta 앱 이름')).toBeLessThan(html.indexOf('Threads 계정 이름'));
  expect(html.indexOf('Threads 계정 이름')).toBeLessThan(html.indexOf('장기 토큰'));
  expect(html).toContain('value="뷰티 앱"');
  expect(html).toContain('type="password"');
  expect(html).not.toContain('numeric');
  expect(html).not.toContain('App ID');
});

it('keeps same-name accounts separately visible and never treats names as app verification', () => {
  mock([
    row,
    {
      ...row,
      localId: 'local-2',
      registrationId: 'registration-2',
      account: { ...server, id: 'server-2', registrationId: 'registration-2' },
    },
  ]);
  const html = render();
  expect((html.match(/>뷰티 계정<\/strong>/g) ?? []).length).toBe(2);
  expect((html.match(/확인되지 않음/g) ?? []).length).toBe(2);
  expect(html).not.toContain('휴대폰 확인 보고 있음');
});

it('shows a stored actual Meta App ID only as read-only metadata when available', () => {
  mock([{ ...row, appId: '123', account: { ...server, appId: '123' } }]);
  const html = render();
  expect(html).toContain('title="Meta App ID: 123"');
  expect(html).toContain('App ID 123');
  expect(html).not.toContain('inputMode');
});

it('keeps local-save recovery distinct from deletion of a registered account', () => {
  const pending = {
    ...row,
    account: null,
    localState: 'pending' as const,
    pendingAction: 'create' as const,
  };
  mock([pending]);
  const html = render();
  expect(html).toContain('서버 저장 대기');
  expect(html).toContain('저장 재시도');
  expect(html).toContain('보류 취소');
  expect(html).not.toContain('계정 삭제');
  expect(managedThreadsActionAvailability(null)).toMatchObject({
    replace: false,
    retry: false,
    discard: false,
    remove: false,
  });
  expect(managedThreadsActionAvailability(pending)).toMatchObject({
    replace: false,
    retry: true,
    discard: true,
    remove: false,
  });
  expect(managedThreadsActionAvailability(row)).toMatchObject({
    replace: true,
    retry: false,
    discard: false,
    remove: true,
  });
});

it('edits the two display names before the token actions, independent of a pending token', () => {
  mock([row]);
  const html = render();
  expect(html.indexOf('>정보 수정</button>')).toBeGreaterThan(-1);
  expect(html.indexOf('>정보 수정</button>')).toBeLessThan(html.indexOf('>토큰 교체</button>'));
  expect(managedThreadsActionAvailability(row).edit).toBe(true);
  expect(
    managedThreadsActionAvailability({ ...row, pendingAction: 'replace', localState: 'pending' })
      .edit,
  ).toBe(true);
  for (const blocked of [
    { ...row, account: null, pendingAction: 'create' as const },
    { ...row, pendingDeletion: true },
    { ...row, localState: 'missing' as const },
  ])
    expect(managedThreadsActionAvailability(blocked).edit).toBe(false);
  expect(managedThreadsNameProblem({ appName: ' 새 앱 ', label: '새 계정' })).toBeNull();
  expect(managedThreadsNameProblem({ appName: ' ', label: '새 계정' })).toContain('Meta 앱 이름');
  expect(managedThreadsNameProblem({ appName: '앱', label: '가'.repeat(81) })).toContain(
    'Threads 계정 이름',
  );
});

it('does not offer re-upload for conflicted changes or missing server accounts', () => {
  const conflicted = { ...row, localState: 'conflict' as const, pendingAction: 'replace' as const };
  mock([conflicted]);
  const conflict = render();
  expect(conflict).toContain('서버의 최신 정보와 충돌');
  expect(managedThreadsActionAvailability(conflicted)).toMatchObject({
    replace: false,
    retry: false,
    discard: true,
    remove: false,
  });
  const absent = { ...row, localState: 'missing' as const };
  mock([absent]);
  const missing = render();
  expect(missing).toContain('서버 목록에서 계정을 찾을 수 없음');
  expect(managedThreadsActionAvailability(absent)).toMatchObject({
    replace: false,
    retry: false,
    discard: false,
    remove: false,
  });
});

it('labels validation as a phone report and keeps App ID verification separate', () => {
  mock([
    {
      ...row,
      account: {
        ...server,
        validationStatus: 'reported_valid',
        threadsUserId: '777',
        expiresAt: '2026-11-19T00:00:00.000Z',
      },
    },
  ]);
  const html = render();
  expect(html).toContain('휴대폰에서 확인했다고 보고됨');
  expect(html).toContain('확인되지 않음');
  expect(html).toContain('777');
  expect(html).toContain('확인 ID: 777');
  expect(html).toContain('title="뷰티 계정"');
  expect(html).toContain('보고된 만료 일시');
});

it('locks actions while disconnected or busy without showing secret values', () => {
  mock([row], false);
  const locked = render(false);
  expect(locked).toContain('disabled=""');
  expect(locked).not.toContain('type="password"');
  expect(locked).not.toContain('App Secret');
  expect(locked).not.toContain('뷰티 마케팅 앱');
  mock([row], true);
  const busy = render();
  expect(busy).toContain('동기화 중…');
  expect((busy.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(7);
  expect(busy).toContain('type="radio"');
  expect(busy).toContain('disabled=""');
});

it('preserves the uncertain-delete row and only offers explicit deletion retry', () => {
  const pending = { ...row, pendingDeletion: true, localState: 'pending' as const };
  mock([pending]);
  const html = render();
  expect(html).toContain('삭제 결과 확인 필요');
  expect(html).toContain('뷰티 마케팅 앱');
  expect(managedThreadsActionAvailability(pending)).toMatchObject({
    replace: false,
    retry: false,
    discard: false,
    remove: true,
  });
});

it('shows account-specific deletion consequences in a separate confirmation without acting', () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  const html = renderToStaticMarkup(
    createElement(ManagedThreadsDeleteConfirmation, { row, busy: false, onConfirm, onClose }),
  );
  expect(html).toContain('<dialog');
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain('뷰티 마케팅 앱');
  expect(html).toContain('뷰티 계정');
  expect(html).toContain('실제 Threads 계정·게시글과 기존 완료 이력은 삭제하지 않습니다.');
  expect(html).toContain('게시 대기·미게시 댓글과');
  expect(html).toContain('진행 중·결과 불명 등록 작업을 종료합니다.');
  expect(html).toContain('이미 Meta로 전송한 요청은 취소할 수 없으며');
  expect(html).toContain('휴대폰을 다시 연결');
  expect(html).toContain('계정 삭제 확인');
  expect(html).not.toContain('type="password"');
  expect(onConfirm).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});

it('explains unknown deletion results and blocks closing or confirmation while processing', () => {
  const html = renderToStaticMarkup(
    createElement(ManagedThreadsDeleteConfirmation, {
      row: { ...row, pendingDeletion: true },
      busy: true,
      onConfirm: vi.fn(),
      onClose: vi.fn(),
    }),
  );
  expect(html).toContain('이전 삭제 결과를 아직 확인하지 못했습니다.');
  expect(html).toContain('삭제 중…');
  expect((html.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(3);
});

it('renders an empty list without token or publishing controls', () => {
  const html = render();
  expect(html).toContain('등록된 Threads 계정이 없습니다.');
  expect(html).toContain('계정 추가');
  expect(html).toContain('선택된 계정이 없습니다.');
  expect(html).toContain('colSpan="6"');
  expect(html).not.toContain('API 업로드');
});

it('does not expose suspend, resume, or employee transfer controls', () => {
  mock([row]);
  const html = render();
  expect(html).not.toContain('중지');
  expect(html).not.toContain('재개');
  expect(html).not.toContain('운영 중');
  expect(html).not.toContain('결과 확인이 필요한 작업');
  expect(html).toContain('토큰 교체');
  expect(html).not.toContain('이관');
  expect(html).not.toContain('받는 직원');
  expect(html).not.toContain('받은 요청');
  expect(html).not.toContain('보낸 요청');
  expect(html).not.toContain('>수락</button>');
  expect(html).not.toContain('>거절</button>');
});

it('provides the dialog title, table column headers, and a stable selected radio for same-name rows', () => {
  const header = renderToStaticMarkup(
    createElement(ManagedThreadsAccountSettings, {
      enabled: true,
      titleId: 'account-dialog-title',
    }),
  );
  expect(header).toContain('<h2 id="account-dialog-title">계정 관리</h2>');
  expect(header).not.toContain('내 Threads 계정');
  const duplicate = { ...row, localId: 'second-local', registrationId: 'second-registration' };
  const html = renderToStaticMarkup(
    createElement(ManagedThreadsAccountTable, {
      rows: [row, duplicate],
      selectedId: duplicate.localId,
      selectionName: 'select-account',
      disabled: false,
      loaded: true,
      enabled: true,
      onSelect: vi.fn(),
    }),
  );
  expect((html.match(/scope="col"/g) ?? []).length).toBe(6);
  expect(html).toContain('앱 이름');
  expect(html).toContain('Threads ID');
  expect(html).toContain('휴대폰 토큰 확인');
  expect(html).toContain('앱 연결 확인');
  expect(html).toContain('보고된 만료 일시');
  expect((html.match(/checked=""/g) ?? []).length).toBe(1);
  expect((html.match(/managed-threads-row-selected/g) ?? []).length).toBe(1);
});
