import { expect, it, vi } from 'vitest';
import { IPC } from '../shared/contracts';
import { handleManagedThreadsRequest } from './managed-threads-ipc';

it('rejects arbitrary account operations and extra arguments before any manager work', () => {
  const manager = {
    getAccounts: vi.fn(),
    deleteAccount: vi.fn(),
    register: vi.fn(),
    replace: vi.fn(),
    update: vi.fn(),
    retry: vi.fn(),
    discardPending: vi.fn(),
  };
  for (const [channel, args] of [
    ['tmm:managed-threads:read-token', ['account']],
    ['tmm:managed-threads:fetch', ['https://graph.threads.net/me']],
    [IPC.managedThreadsAccounts, [{ ownerId: 'other-user' }]],
    [IPC.registerManagedThreadsAccount, []],
    [IPC.deleteManagedThreadsAccount, []],
    [IPC.deleteManagedThreadsAccount, [{}, { ownerId: 'other-user' }]],
    [IPC.replaceManagedThreadsToken, [{}, { ownerId: 'other-user' }]],
    [IPC.updateManagedThreadsAccount, []],
    [IPC.updateManagedThreadsAccount, [{}, { ownerId: 'other-user' }]],
    [IPC.retryManagedThreadsAccount, []],
    [IPC.discardPendingManagedThreadsAccount, []],
    ['tmm:managed-threads:status', [{ status: 'suspended' }]],
    ['tmm:managed-threads:transfer-request', [{}]],
    ['tmm:managed-threads:transfer-respond', [{ action: 'accept' }]],
    ['tmm:managed-threads:operation-retry', [{ operationId: 'old' }]],
  ] as const) {
    expect(() => handleManagedThreadsRequest(channel, [...args], manager)).toThrow();
  }
  for (const action of Object.values(manager)) expect(action).not.toHaveBeenCalled();
});

it('dispatches an explicit account deletion through only the fixed delete channel', async () => {
  const result = { status: 'ok' as const, accounts: [], problem: null };
  const manager = {
    getAccounts: vi.fn(),
    register: vi.fn(),
    replace: vi.fn(),
    update: vi.fn(),
    retry: vi.fn(),
    discardPending: vi.fn(),
    deleteAccount: vi.fn().mockResolvedValue(result),
  };
  const input = { accountId: 'account-1', expectedRevision: 2 };
  expect(
    await handleManagedThreadsRequest(IPC.deleteManagedThreadsAccount, [input], manager),
  ).toEqual(result);
  expect(manager.deleteAccount).toHaveBeenCalledExactlyOnceWith(input);
  expect(manager.discardPending).not.toHaveBeenCalled();
});
