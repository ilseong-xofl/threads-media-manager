import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ManagedThreadsAccountRow, ManagedThreadsTokenCheck } from '../shared/managed-threads';
import {
  ManagedThreadsAccountSettings,
  ManagedThreadsAccountFields,
  ManagedThreadsAccountTable,
  ManagedThreadsDeleteConfirmation,
  managedThreadsActionAvailability,
  managedThreadsCheckLines,
  managedThreadsCooldownLabel,
  managedThreadsExpiryNotice,
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
  pendingReason: null,
  pendingDeletion: false,
  lastCheck: null,
};
const NOW = Date.parse('2026-10-28T00:00:00.000Z');
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const verified = (expiresAt: string | null): ManagedThreadsAccountRow => ({
  ...row,
  account: { ...server, validationStatus: 'reported_valid', threadsUserId: '777', expiresAt },
});
function mock(
  rows: ManagedThreadsAccountRow[] = [],
  busy = false,
  loaded = true,
  cooldownUntil = 0,
) {
  vi.mocked(useManagedThreads).mockReturnValue({
    accounts: rows,
    busy,
    loaded,
    cooldownUntil,
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
    discard: vi.fn(),
  });
}
function render(enabled = true) {
  return renderToStaticMarkup(createElement(ManagedThreadsAccountSettings, { enabled }));
}
beforeEach(() => {
  mock();
});
afterEach(() => {
  vi.useRealTimers();
});

it('distinguishes local synchronization from the PC token check', () => {
  mock([row]);
  const html = render();
  expect(html).toContain('서버와 동기화됨');
  expect(html).toContain('확인 필요');
  expect(html).toContain('토큰 확인·갱신은 이 PC 프로그램이 Meta에 직접 요청');
  expect(html).toContain('10분에 한 번');
  expect(html).not.toContain('휴대폰에서');
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

it('keeps same-name accounts separately visible', () => {
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
  // Meta buttons wrap their label so the request countdown can sit under it.
  expect(html.indexOf('>정보 수정</button>')).toBeLessThan(html.indexOf('>토큰 교체</span>'));
  expect(html.indexOf('>토큰 교체</span>')).toBeLessThan(html.indexOf('>다시 확인</span>'));
  expect(html.indexOf('>다시 확인</span>')).toBeLessThan(html.indexOf('>갱신</span>'));
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

it('labels a checked token with its expiry', () => {
  vi.useFakeTimers({ now: NOW });
  mock([verified(inDays(21.5))]);
  const html = render();
  expect(html).toContain('확인됨');
  expect(html).toContain('확인 ID: 777');
  expect(html).toContain('title="뷰티 계정"');
  expect(html).toContain('만료 일시');
  expect(html).toContain('22일 남음');
  mock([
    verified(inDays(-1)),
    { ...row, localId: 'invalid', account: { ...server, validationStatus: 'invalid' } },
    { ...row, localId: 'unsaved', account: null, pendingAction: 'create', localState: 'pending' },
  ]);
  const states = render();
  expect(states).toContain('만료됨');
  expect(states).toContain('사용할 수 없음');
  expect(states).toContain('서버 저장 후 확인');
  expect(states).toContain('확인 전');
  expect(states).not.toContain('휴대폰');
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
  expect((busy.match(/<button[^>]*disabled=""/g) ?? []).length).toBe(9);
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
  expect(html).toContain('colSpan="5"');
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
  expect((html.match(/scope="col"/g) ?? []).length).toBe(5);
  expect(html).toContain('앱 이름');
  expect(html).toContain('Threads ID');
  expect(html).toContain('>토큰 확인</th>');
  expect(html).not.toContain('앱 연결 확인');
  expect(html).toContain('>만료 일시</th>');
  expect(html).not.toContain('휴대폰 토큰 확인');
  expect(html).not.toContain('보고된 만료 일시');
  expect((html.match(/checked=""/g) ?? []).length).toBe(1);
  expect((html.match(/managed-threads-row-selected/g) ?? []).length).toBe(1);
});

it('shows the shared Meta request countdown under every Meta button and disables them', () => {
  vi.useFakeTimers({ now: NOW });
  mock([row], false, true, NOW + 125_000);
  const html = render();
  expect((html.match(/2:05 후 가능/g) ?? []).length).toBe(4);
  for (const label of ['계정 추가', '토큰 교체', '다시 확인', '갱신'])
    expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>(?:(?!</button>).)*${label}`));
  expect(managedThreadsCooldownLabel(0)).toBeNull();
  expect(managedThreadsCooldownLabel(-5)).toBeNull();
  expect(managedThreadsCooldownLabel(1)).toBe('0:01 후 가능');
  expect(managedThreadsCooldownLabel(59_001)).toBe('1:00 후 가능');
  expect(managedThreadsCooldownLabel(600_000)).toBe('10:00 후 가능');
});

it('offers re-check on any synchronized account and refresh only near a verified expiry', () => {
  const available = (value: ManagedThreadsAccountRow, days = 14) =>
    managedThreadsActionAvailability(value, NOW, days);
  expect(available(row)).toMatchObject({ recheck: true, refresh: false });
  expect(available(verified(inDays(10)))).toMatchObject({ recheck: true, refresh: true });
  expect(available(verified(inDays(14)))).toMatchObject({ refresh: true });
  expect(available(verified(inDays(14.5)))).toMatchObject({ refresh: false });
  expect(available(verified(inDays(14.5)), 30)).toMatchObject({ refresh: true });
  expect(available(verified(inDays(-0.1)))).toMatchObject({ recheck: true, refresh: false });
  expect(available(verified(null))).toMatchObject({ refresh: false });
  for (const blocked of [
    { ...verified(inDays(3)), pendingAction: 'replace' as const, localState: 'pending' as const },
    { ...verified(inDays(3)), pendingDeletion: true },
    { ...verified(inDays(3)), localState: 'missing' as const },
    { ...verified(inDays(3)), localState: 'conflict' as const },
  ])
    expect(available(blocked)).toMatchObject({ recheck: false, refresh: false });
  const refreshing = {
    ...verified(inDays(3)),
    pendingAction: 'replace' as const,
    pendingReason: 'refresh' as const,
    localState: 'pending' as const,
  };
  expect(available(refreshing)).toMatchObject({ retry: true, discard: false, replace: false });
  expect(available({ ...refreshing, localState: 'conflict' })).toMatchObject({ discard: true });
});

it('lists the last token check with codes for copying and labels each field', () => {
  const check: ManagedThreadsTokenCheck = {
    at: '2026-10-28T01:02:00.000Z',
    operation: 'recheck',
    result: 'invalid_token',
    detail: null,
    expiresAt: null,
    httpStatus: 400,
    metaCode: 190,
    metaSubcode: 463,
    metaType: 'OAuthException',
    metaMessage: 'Session has expired',
    fbtraceId: 'trace-1',
    networkCode: null,
  };
  expect(managedThreadsCheckLines(check)).toEqual([
    '확인 시각: 2026. 10. 28. 10:02',
    '작업: 다시 확인',
    '결과: 유효하지 않은 토큰',
    'HTTP 상태: 400',
    'Meta 코드: 190',
    '하위 코드: 463',
    '유형: OAuthException',
    '메시지: Session has expired',
    'fbtrace_id: trace-1',
  ]);
  expect(
    managedThreadsCheckLines({
      ...check,
      operation: 'refresh',
      result: 'not_sent',
      detail: null,
      httpStatus: null,
      metaCode: null,
      metaSubcode: null,
      metaType: null,
      metaMessage: null,
      fbtraceId: null,
      networkCode: 'ENOTFOUND',
    }).slice(1),
  ).toEqual(['작업: 갱신', '결과: 요청을 보내지 못함', '네트워크 코드: ENOTFOUND']);
  expect(managedThreadsCheckLines({ ...check, detail: 'short_lived' })[2]).toBe(
    '결과: 유효하지 않은 토큰 · 남은 기간 24시간 미만(단기 토큰)',
  );
});

it('builds one login notice for verified accounts that expired or expire within the window', () => {
  const named = (label: string, value: ManagedThreadsAccountRow) => ({
    ...value,
    localId: label,
    label,
  });
  expect(
    managedThreadsExpiryNotice(
      [
        named('지난', verified(inDays(-2))),
        named('임박', verified(inDays(2.5))),
        named('경계', verified(inDays(14))),
        named('여유', verified(inDays(30))),
        named('미확인', { ...row, account: { ...server, expiresAt: inDays(1) } }),
        named('삭제 중', { ...verified(inDays(1)), pendingDeletion: true }),
      ],
      14,
      NOW,
    ),
  ).toBe(
    '토큰 만료를 확인해 주세요. 만료됨: 지난 / 14일 이내 만료: 임박(3일), 경계(14일). 계정 관리에서 갱신하거나 토큰을 교체할 수 있습니다.',
  );
  expect(managedThreadsExpiryNotice([verified(inDays(30)), row], 14, NOW)).toBeNull();
});
