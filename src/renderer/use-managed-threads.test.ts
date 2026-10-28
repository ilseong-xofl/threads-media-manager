import { describe, expect, it, vi } from 'vitest';
import type { ManagedThreadsAccountRow, ManagedThreadsResult } from '../shared/managed-threads';
import { createManagedThreadsController } from './use-managed-threads';

const ok = (accounts: ManagedThreadsAccountRow[] = []): ManagedThreadsResult => ({
  status: 'ok',
  accounts,
  problem: null,
  metaRequestRetryAfterSeconds: 0,
  refreshWindowDays: 14,
});
const row: ManagedThreadsAccountRow = {
  localId: 'local-1',
  label: '뷰티',
  appName: '뷰티 앱',
  registrationId: 'registration-1',
  appId: null,
  account: null,
  localRevision: null,
  localState: 'pending',
  pendingAction: 'create',
  pendingReason: null,
  pendingDeletion: false,
  lastCheck: null,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  const api = {
    getManagedThreadsAccounts: vi.fn().mockResolvedValue(ok()),
    registerManagedThreadsAccount: vi.fn().mockResolvedValue(ok()),
    replaceManagedThreadsToken: vi.fn().mockResolvedValue(ok()),
    updateManagedThreadsAccount: vi.fn().mockResolvedValue(ok()),
    recheckManagedThreadsAccount: vi.fn().mockResolvedValue(ok()),
    refreshManagedThreadsToken: vi.fn().mockResolvedValue(ok()),
    deleteManagedThreadsAccount: vi.fn().mockResolvedValue(ok()),
    retryManagedThreadsAccount: vi.fn().mockResolvedValue(ok()),
  };
  const effects = { notify: vi.fn(), onSyncing: vi.fn() };
  return { api, effects, controller: createManagedThreadsController(api, effects) };
}
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('managed Threads account request lifecycle', () => {
  it('does not fetch or write while locked; enabling only reads the server', async () => {
    const { api, controller, effects } = setup();
    await controller.synchronize();
    await controller.register({ label: '뷰티', appName: '뷰티 앱', token: 'synthetic-token' });
    expect(api.getManagedThreadsAccounts).not.toHaveBeenCalled();
    expect(api.registerManagedThreadsAccount).not.toHaveBeenCalled();
    controller.setEnabled(true);
    await settle();
    expect(api.getManagedThreadsAccounts).toHaveBeenCalledOnce();
    expect(controller.getSnapshot()).toEqual({
      accounts: [],
      busy: false,
      loaded: true,
      cooldownUntil: 0,
      refreshWindowDays: 14,
    });
    expect(effects.notify).not.toHaveBeenCalled();
    expect(effects.onSyncing.mock.calls).toEqual([[true], [false]]);
  });

  it('deduplicates clicks and blocks writes during a current read', async () => {
    const { api, controller } = setup();
    const pending = deferred<ManagedThreadsResult>();
    api.getManagedThreadsAccounts.mockReturnValueOnce(pending.promise);
    controller.setEnabled(true);
    expect(controller.getSnapshot().busy).toBe(true);
    expect(await controller.synchronize(true)).toBe(false);
    expect(await controller.retry({ localId: 'local-1' })).toBe(false);
    expect(api.getManagedThreadsAccounts).toHaveBeenCalledOnce();
    expect(api.retryManagedThreadsAccount).not.toHaveBeenCalled();
    pending.resolve(ok([row]));
    await settle();
    expect(controller.getSnapshot().accounts).toEqual([row]);
  });

  it('preserves returned pending data and only retries on the explicit action', async () => {
    const { api, controller, effects } = setup();
    api.getManagedThreadsAccounts.mockResolvedValue(ok([row]));
    api.registerManagedThreadsAccount.mockResolvedValue({
      status: 'error',
      accounts: [row],
      problem: { code: 'SERVICE_UNAVAILABLE', message: '서버 연결을 확인하세요.' },
    });
    controller.setEnabled(true);
    await settle();
    expect(
      await controller.register({ label: '뷰티', appName: '뷰티 앱', token: 'synthetic-token' }),
    ).toBe(false);
    expect(controller.getSnapshot().accounts).toEqual([row]);
    expect(effects.notify).toHaveBeenCalledWith('서버 연결을 확인하세요.', true);
    await controller.synchronize(true);
    expect(api.retryManagedThreadsAccount).not.toHaveBeenCalled();
    expect(api.registerManagedThreadsAccount).toHaveBeenCalledOnce();
    await controller.retry({ localId: 'local-1' });
    expect(api.retryManagedThreadsAccount).toHaveBeenCalledWith({ localId: 'local-1' });
  });

  it('ignores old results and notices after locking, then reads fresh data on reconnect', async () => {
    const { api, controller, effects } = setup();
    const pending = deferred<ManagedThreadsResult>();
    controller.setEnabled(true);
    await settle();
    api.registerManagedThreadsAccount.mockReturnValueOnce(pending.promise);
    const request = controller.register({
      label: '뷰티',
      appName: '뷰티 앱',
      token: 'synthetic-token',
    });
    controller.setEnabled(false);
    expect(controller.getSnapshot()).toEqual({
      accounts: [],
      loaded: false,
      busy: false,
      cooldownUntil: 0,
      refreshWindowDays: 14,
    });
    controller.setEnabled(true);
    expect(api.getManagedThreadsAccounts).toHaveBeenCalledOnce();
    pending.resolve(ok([row]));
    expect(await request).toBe(false);
    await settle();
    expect(api.getManagedThreadsAccounts).toHaveBeenCalledTimes(2);
    expect(controller.getSnapshot().accounts).toEqual([]);
    expect(effects.notify).not.toHaveBeenCalled();
    expect(api.registerManagedThreadsAccount).toHaveBeenCalledOnce();
  });

  it('never exposes thrown IPC details in a toast and retains already loaded metadata', async () => {
    const { api, controller, effects } = setup();
    api.getManagedThreadsAccounts.mockResolvedValueOnce(ok([row]));
    controller.setEnabled(true);
    await settle();
    api.getManagedThreadsAccounts.mockRejectedValueOnce(new Error('sensitive-transport-content'));
    await controller.synchronize();
    expect(controller.getSnapshot().accounts).toEqual([row]);
    expect(effects.notify.mock.calls.flat().join()).not.toContain('sensitive-transport-content');
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it('sends the selected revision and never retries a change on its own', async () => {
    const { api, controller } = setup();
    controller.setEnabled(true);
    await settle();
    const replacement = { accountId: 'account-2', expectedRevision: 7, token: 'synthetic-token' };
    await controller.replace(replacement);
    expect(api.replaceManagedThreadsToken).toHaveBeenCalledWith(replacement);
    expect(api.retryManagedThreadsAccount).not.toHaveBeenCalled();
  });

  it('only deletes on explicit confirmation and never retries deletion on reconnect', async () => {
    const { api, controller, effects } = setup();
    const pending = { ...row, pendingAction: null, pendingDeletion: true };
    api.getManagedThreadsAccounts.mockResolvedValue(ok([pending]));
    controller.setEnabled(true);
    await settle();
    expect(api.deleteManagedThreadsAccount).not.toHaveBeenCalled();
    api.deleteManagedThreadsAccount.mockResolvedValue({
      status: 'error',
      accounts: [pending],
      problem: { code: 'SERVICE_UNAVAILABLE', message: '삭제 결과를 확인하지 못했습니다.' },
    });
    const input = { accountId: 'account-1', expectedRevision: 4 };
    expect(await controller.remove(input)).toBe(false);
    expect(api.deleteManagedThreadsAccount).toHaveBeenCalledExactlyOnceWith(input);
    expect(controller.getSnapshot().accounts).toEqual([pending]);
    expect(effects.notify).toHaveBeenCalledWith('삭제 결과를 확인하지 못했습니다.', true);
    controller.setEnabled(false);
    expect(await controller.remove(input)).toBe(false);
    controller.setEnabled(true);
    await settle();
    await controller.synchronize();
    expect(api.deleteManagedThreadsAccount).toHaveBeenCalledOnce();
    expect(api.retryManagedThreadsAccount).not.toHaveBeenCalled();
    api.deleteManagedThreadsAccount.mockResolvedValue(ok());
    expect(await controller.remove(input)).toBe(true);
    expect(controller.getSnapshot().accounts).toEqual([]);
  });

  it('prevents duplicate deletion while pending and ignores a response after service lock', async () => {
    const { api, controller, effects } = setup();
    const request = deferred<ManagedThreadsResult>();
    controller.setEnabled(true);
    await settle();
    api.deleteManagedThreadsAccount.mockReturnValueOnce(request.promise);
    const input = { accountId: 'account-1', expectedRevision: 4 };
    const first = controller.remove(input);
    expect(await controller.remove(input)).toBe(false);
    controller.setEnabled(false);
    request.resolve(ok([row]));
    expect(await first).toBe(false);
    expect(controller.getSnapshot()).toEqual({
      accounts: [],
      busy: false,
      loaded: false,
      cooldownUntil: 0,
      refreshWindowDays: 14,
    });
    expect(api.deleteManagedThreadsAccount).toHaveBeenCalledOnce();
    expect(effects.notify).not.toHaveBeenCalled();
  });
});

describe('PC token checks in the account controller', () => {
  it('keeps the Meta request countdown from every result, including errors', async () => {
    const { api, controller } = setup();
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    controller.setEnabled(true);
    await settle();
    expect(controller.getSnapshot().cooldownUntil).toBe(0);
    api.recheckManagedThreadsAccount.mockResolvedValueOnce({
      ...ok([row]),
      status: 'error',
      problem: { code: 'TOKEN_CHECK_FAILED', message: '토큰을 확인하지 못했습니다.' },
      metaRequestRetryAfterSeconds: 300,
      refreshWindowDays: 60,
    });
    expect(await controller.recheck({ accountId: 'account-1' })).toBe(false);
    expect(api.recheckManagedThreadsAccount).toHaveBeenCalledWith({ accountId: 'account-1' });
    expect(controller.getSnapshot()).toMatchObject({
      cooldownUntil: 1_300_000,
      refreshWindowDays: 60,
    });
    api.getManagedThreadsAccounts.mockResolvedValueOnce(ok([row]));
    await controller.synchronize();
    expect(controller.getSnapshot().cooldownUntil).toBe(0);
    vi.restoreAllMocks();
  });
  it('closes the form when a failed check still saved the account, but not otherwise', async () => {
    const { api, controller, effects } = setup();
    controller.setEnabled(true);
    await settle();
    api.registerManagedThreadsAccount.mockResolvedValueOnce({
      ...ok([row]),
      status: 'error',
      problem: { code: 'TOKEN_CHECK_FAILED_SAVED', message: '"확인 필요"로 저장했습니다.' },
    });
    expect(
      await controller.register({ label: '뷰티', appName: '뷰티 앱', token: 'synthetic-token' }),
    ).toBe(true);
    expect(effects.notify).toHaveBeenLastCalledWith('"확인 필요"로 저장했습니다.', true);
    api.replaceManagedThreadsToken.mockResolvedValueOnce({
      ...ok([row]),
      status: 'error',
      problem: { code: 'TOKEN_CHECK_FAILED', message: '기존 토큰을 그대로 두었습니다.' },
    });
    expect(
      await controller.replace({ accountId: 'account-1', expectedRevision: 1, token: 'x' }),
    ).toBe(false);
  });
  it('refreshes one account only through its explicit action', async () => {
    const { api, controller, effects } = setup();
    controller.setEnabled(true);
    await settle();
    expect(await controller.refreshToken({ accountId: 'account-1' })).toBe(true);
    expect(api.refreshManagedThreadsToken).toHaveBeenCalledExactlyOnceWith({
      accountId: 'account-1',
    });
    expect(effects.notify).toHaveBeenLastCalledWith('토큰을 갱신하고 새 만료 일시를 저장했습니다.');
    expect(api.getManagedThreadsAccounts).toHaveBeenCalledOnce();
  });
});
