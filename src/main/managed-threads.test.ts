import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthTokenStore, TokenCipher } from './auth-token-store';
import type {
  DeletedManagedThreadsAccount,
  ManagedThreadsAccount,
} from '../shared/managed-threads';
import { EncryptedManagedThreadsStore, ManagedThreadsStorageError } from './managed-threads-store';
import { ManagedThreadsManager } from './managed-threads';
import { ServiceApiClient } from './service-api';
import { ServiceAccess } from './service-access';

const scope = 'https://admin.example.test';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers });
async function setup() {
  let session: string | null = 'session-a';
  const tokenStore: AuthTokenStore = {
    read: async () => session,
    write: async (v) => {
      session = v;
    },
    clear: async () => {
      session = null;
    },
  };
  const server = new Map<string, { account: ManagedThreadsAccount; token: string }>();
  const deleted = new Map<string, DeletedManagedThreadsAccount & { ownerId: string }>();
  let next = 0;
  let loseResponse = false,
    rejectMutation = false;
  const writes: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const user = new Headers(init?.headers).get('Authorization') === 'Bearer session-b' ? 'b' : 'a';
    if (path === '/api/v1/access')
      return json({
        user: { id: user, displayName: user, email: `${user}@ilscp.net` },
        mustChangePassword: false,
        permissions: { app: true },
      });
    if (path === '/api/auth/sign-out') return json({ success: true });
    if (path === '/api/auth/sign-in/email') return json({}, 200, { 'set-auth-token': 'session-b' });
    if (path === '/api/v1/threads/accounts' && init?.method === 'GET')
      return json({
        deletedAccounts: [...deleted.values()]
          .filter((d) => d.ownerId === user)
          .map((d) => ({ id: d.id, registrationId: d.registrationId, deletedAt: d.deletedAt })),
        accounts: [...server.values()]
          .filter((r) => r.account.ownerId === user)
          .map((r) => r.account),
      });
    if (init?.method === 'DELETE') {
      writes.push('DELETE');
      if (rejectMutation) return json({}, 503);
      const id = path.split('/')[5];
      const old = deleted.get(id);
      if (old) return old.ownerId === user ? json({ deletedAccount: old }) : json({}, 404);
      const row = server.get(id);
      if (!row || row.account.ownerId !== user) return json({}, 404);
      const body = JSON.parse(init.body as string);
      if (body.expectedRevision !== row.account.tokenRevision) return json({}, 409);
      const tombstone = {
        id,
        registrationId: row.account.registrationId,
        ownerId: user,
        deletedAt: '2026-10-19T01:00:00.000Z',
      };
      deleted.set(id, tombstone);
      server.delete(id);
      if (loseResponse) throw new Error('lost delete response');
      return json({ deletedAccount: tombstone });
    }
    if (init?.method === 'POST' || init?.method === 'PUT') {
      writes.push(init.method);
      if (rejectMutation)
        return json({ error: { code: 'INTERNAL_ERROR', message: 'secret-in-error' } }, 503);
      const body = JSON.parse(init.body as string);
      let row;
      if (init.method === 'POST') {
        const existing = [...server.values()].find(
          (r) => r.account.registrationId === body.registrationId,
        );
        if (existing) {
          if (
            existing.account.ownerId !== user ||
            existing.account.label !== body.label ||
            existing.account.appName !== body.appName ||
            (existing.account.tokenRevision === 1 && existing.token !== body.token)
          )
            return json({}, 409);
          return json({ account: existing.account });
        }
        row = {
          account: {
            id: `id-${++next}`,
            ownerId: user,
            label: body.label,
            registrationId: body.registrationId,
            appName: body.appName,
            appId: null,
            threadsUserId: null,
            validationStatus: 'pending_validation' as const,
            appIdVerified: false,
            tokenRevision: 1,
            expiresAt: null,
            createdAt: '2026-10-19T00:00:00.000Z',
          },
          token: body.token,
        };
        server.set(row.account.id, row);
      } else {
        row = server.get(path.split('/')[5]);
        if (!row || row.account.ownerId !== user) return json({}, 404);
        if (row.account.tokenRevision !== body.expectedRevision) return json({}, 409);
        row.token = body.token;
        row.account.tokenRevision++;
      }
      if (loseResponse) throw new Error('network lost with secret-in-error');
      return json({ account: row.account, secret: 'must-never-leak' });
    }
    const row = server.get(path.split('/')[5]);
    if (!row || row.account.ownerId !== user) return json({}, 404);
    return json({ ...row, unexpectedSecret: 'must-never-leak' });
  });
  const client = new ServiceApiClient(scope, tokenStore, fetcher);
  const directory = await mkdtemp(join(tmpdir(), 'managed-manager-'));
  directories.push(directory);
  const key = randomBytes(32);
  // A reversible test cipher keeps fixtures deterministic; production supplies Electron safeStorage.
  const cipher: TokenCipher = {
    isEncryptionAvailable: async () => true,
    encryptString: async (v) => Buffer.from(Buffer.from(v).map((n, i) => n ^ key[i % key.length])),
    decryptString: async (v) => Buffer.from(v.map((n, i) => n ^ key[i % key.length])).toString(),
  };
  const store = new EncryptedManagedThreadsStore(join(directory, 'accounts.bin'), cipher);
  const manager = new ManagedThreadsManager(client, store, scope);
  return {
    server,
    deleted,
    client,
    manager,
    store,
    writes,
    fetcher,
    lose: (v: boolean) => {
      loseResponse = v;
    },
    reject: (v: boolean) => {
      rejectMutation = v;
    },
  };
}
const input = (appName = '123') => ({
  label: `계정 ${appName}`,
  appName,
  token: `private-token-${appName}`,
});

const legacyRecord = () => ({
  localId: 'legacy-local',
  registrationId: 'legacy-local',
  appName: '123',
  label: '예전 계정',
  appId: '123',
  legacyAppId: '123',
  account: null,
  syncedToken: null,
  pending: { action: 'create' as const, token: 'legacy-secret', expectedRevision: null },
  pendingDeletion: null,
  conflict: false,
  missing: false,
});
const legacyRemote = (token: string): { account: ManagedThreadsAccount; token: string } => ({
  account: {
    id: 'legacy-server',
    registrationId: 'legacy-server',
    appName: '123',
    ownerId: 'a',
    label: '예전 계정',
    appId: '123',
    threadsUserId: null,
    validationStatus: 'pending_validation',
    appIdVerified: false,
    tokenRevision: 1,
    expiresAt: null,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  token,
});

describe('managed Threads synchronization', () => {
  it('registers multiple accounts, exposes metadata only and separates another logged-in owner', async () => {
    const { manager, client, store } = await setup();
    expect((await manager.register(input())).status).toBe('ok');
    const two = await manager.register(input('456'));
    expect(two.accounts).toHaveLength(2);
    expect(JSON.stringify(two)).not.toMatch(/private-token|must-never-leak|syncedToken/);
    expect((await store.read(scope, 'a')).map((r) => r.syncedToken)).toEqual([
      'private-token-123',
      'private-token-456',
    ]);
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    expect((await manager.getAccounts()).accounts).toEqual([]);
    expect((await manager.register(input('789'))).accounts).toHaveLength(1);
    expect(await store.read(scope, 'a')).toHaveLength(2);
    expect(await store.read(scope, 'b')).toHaveLength(1);
  });
  it('persists pending before POST, retains it on service failure, and explicitly retries', async () => {
    const { manager, store, reject, writes } = await setup();
    reject(true);
    const failed = await manager.register(input());
    expect(failed.status).toBe('error');
    expect(failed.accounts[0].localState).toBe('pending');
    expect((await store.read(scope, 'a'))[0].pending?.token).toBe(input().token);
    expect(JSON.stringify(failed)).not.toMatch(/private-token|secret-in-error/);
    reject(false);
    expect((await manager.getAccounts()).accounts[0].localState).toBe('pending');
    expect(writes).toEqual(['POST']);
    const retried = await manager.retry({ localId: failed.accounts[0].localId });
    expect(retried.accounts[0].localState).toBe('synced');
    expect(writes).toEqual(['POST', 'POST']);
  });
  it('reconciles a lost create response by owned registration ID and token without a second POST', async () => {
    const { manager, lose, writes } = await setup();
    lose(true);
    const failed = await manager.register(input());
    lose(false);
    const retried = await manager.retry({ localId: failed.accounts[0].localId });
    expect(retried.status).toBe('ok');
    expect(retried.accounts[0].localState).toBe('synced');
    expect(writes).toEqual(['POST']);
  });
  it('reconciles lost replacement response without a second PUT', async () => {
    const { manager, lose, writes } = await setup();
    const initial = await manager.register(input());
    lose(true);
    const failed = await manager.replace({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
      token: 'replacement-secret',
    });
    expect(failed.accounts[0].localState).toBe('pending');
    lose(false);
    const retried = await manager.retry({ localId: failed.accounts[0].localId });
    expect(retried.status).toBe('ok');
    expect(retried.accounts[0].localRevision).toBe(2);
    expect(writes).toEqual(['POST', 'PUT']);
  });
  it('downloads mobile refresh and never uploads stale local credentials', async () => {
    const { manager, server, store, writes } = await setup();
    const initial = await manager.register(input());
    const row = server.get(initial.accounts[0].account!.id)!;
    row.token = 'mobile-refresh-token';
    row.account.tokenRevision = 2;
    const refreshed = await manager.getAccounts();
    expect(refreshed.accounts[0].localRevision).toBe(2);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe('mobile-refresh-token');
    expect(writes).toEqual(['POST']);
  });
  it('accepts mobile-learned actual App ID metadata without reusing it as connection identity', async () => {
    const { manager, server, store, fetcher } = await setup();
    const initial = await manager.register({ ...input(), appName: '뷰티 앱' });
    const row = server.get(initial.accounts[0].account!.id)!;
    row.account.appId = '123456789';
    row.account.appIdVerified = true;
    fetcher.mockClear();
    const refreshed = await manager.getAccounts();
    expect(refreshed.status).toBe('ok');
    expect(refreshed.accounts[0]).toMatchObject({
      registrationId: initial.accounts[0].registrationId,
      appName: '뷰티 앱',
      appId: '123456789',
      localRevision: 1,
    });
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/credential'))).toHaveLength(
      0,
    );
  });
  it('retains pending replacement on concurrent refresh, blocks retry and discards only pending input', async () => {
    const { manager, server, store, reject, writes } = await setup();
    const initial = await manager.register(input());
    const id = initial.accounts[0].account!.id;
    reject(true);
    const failed = await manager.replace({
      accountId: id,
      expectedRevision: 1,
      token: 'pending-secret',
    });
    reject(false);
    server.get(id)!.account.tokenRevision = 2;
    server.get(id)!.token = 'mobile-secret';
    const retry = await manager.retry({ localId: failed.accounts[0].localId });
    expect(retry.problem?.code).toBe('STALE_CREDENTIAL');
    expect(retry.accounts[0].localState).toBe('conflict');
    expect((await store.read(scope, 'a'))[0].pending?.token).toBe('pending-secret');
    expect(writes).toEqual(['POST', 'PUT']);
    expect(
      (await manager.discardPending({ localId: failed.accounts[0].localId })).accounts[0]
        .localState,
    ).toBe('synced');
    const stored = (await store.read(scope, 'a'))[0];
    expect(stored.syncedToken).toBe('mobile-secret');
    expect(stored.pending).toBeNull();
  });
  it('keeps an ambiguous creation with a different remote token as conflict', async () => {
    const { manager, server, lose, writes } = await setup();
    lose(true);
    const failed = await manager.register(input());
    lose(false);
    [...server.values()][0].token = 'new-mobile-token';
    [...server.values()][0].account.tokenRevision = 2;
    const retried = await manager.retry({ localId: failed.accounts[0].localId });
    expect(retried.problem?.code).toBe('STALE_CREDENTIAL');
    expect(retried.accounts[0].localState).toBe('conflict');
    expect(writes).toEqual(['POST']);
  });
  it('never sends a mutation if persisting pending credentials failed', async () => {
    const { client, store, writes } = await setup();
    const write = vi.fn(
      async (_scope: string, _owner: string, records: Parameters<typeof store.write>[2]) => {
        if (records.some((r) => r.pending))
          throw new ManagedThreadsStorageError('STORAGE_WRITE_FAILED');
      },
    );
    const manager = new ManagedThreadsManager(
      client,
      { read: store.read.bind(store), write },
      scope,
    );
    expect((await manager.register(input())).problem?.code).toBe('STORAGE_WRITE_FAILED');
    expect(writes).toEqual([]);
  });
  it('honestly retains persisted pending state if final local save fails after server success', async () => {
    const { client, store, writes } = await setup();
    const write = vi.fn(
      async (service: string, owner: string, records: Parameters<typeof store.write>[2]) => {
        if (records.some((r) => r.account && !r.pending))
          throw new ManagedThreadsStorageError('STORAGE_WRITE_FAILED');
        await store.write(service, owner, records);
      },
    );
    const manager = new ManagedThreadsManager(
      client,
      { read: store.read.bind(store), write },
      scope,
    );
    const result = await manager.register(input());
    expect(result.problem?.code).toBe('LOCAL_SYNC_PENDING');
    expect(result.accounts[0].localState).toBe('pending');
    expect(writes).toEqual(['POST']);
  });
  it('rejects extra IPC fields, malformed IDs and max revision without business mutations', async () => {
    const { manager, writes } = await setup();
    for (const body of [
      { ...input(), ownerId: 'other' },
      { ...input(), token: 'bad\ntoken' },
      { ...input(), appName: '' },
      { ...input(), appName: 'x'.repeat(81) },
      { ...input(), appId: '123' },
    ])
      expect((await manager.register(body)).problem?.code).toBe('VALIDATION_FAILED');
    expect(
      (await manager.replace({ accountId: 'id', expectedRevision: 2147483647, token: 'secret' }))
        .problem?.code,
    ).toBe('VALIDATION_FAILED');
    expect((await manager.retry({ localId: '../bad' })).problem?.code).toBe('VALIDATION_FAILED');
    expect(writes).toEqual([]);
  });
  it('rejects cross-owner server responses and never leaks response credentials', async () => {
    const { manager, fetcher } = await setup();
    await manager.register(input());
    const account = {
      id: 'other',
      ownerId: 'b',
      label: 'other',
      registrationId: 'other-registration',
      appName: '앱 이름',
      appId: null,
      threadsUserId: null,
      validationStatus: 'pending_validation',
      appIdVerified: false,
      tokenRevision: 1,
      expiresAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    fetcher.mockResolvedValueOnce(
      json({
        user: { id: 'a', displayName: 'a', email: 'a@ilscp.net' },
        mustChangePassword: false,
        permissions: { app: true },
      }),
    );
    fetcher.mockResolvedValueOnce(json({ accounts: [account], token: 'malicious-token' }));
    const result = await manager.getAccounts();
    expect(result.problem?.code).toBe('INVALID_RESPONSE');
    expect(JSON.stringify(result)).not.toMatch(/malicious-token|"ownerId":"b"/);
  });
  it('keeps simultaneous connections with identical names separate by generated IDs', async () => {
    const { manager, writes } = await setup();
    const results = await Promise.all([manager.register(input()), manager.register(input())]);
    expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
    expect(writes).toEqual(['POST', 'POST']);
    expect(new Set(results[1].accounts.map((r) => r.registrationId)).size).toBe(2);
    expect(results[1].accounts.map((r) => r.appName)).toEqual(['123', '123']);
  });
  it('retains staged input when the account-list request fails before POST', async () => {
    const { manager, fetcher, store, writes } = await setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/threads/accounts')) throw new Error('offline');
      return original(url, init);
    });
    const result = await manager.register(input());
    expect(result.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.accounts[0].localState).toBe('pending');
    expect((await store.read(scope, 'a'))[0].pending?.token).toBe(input().token);
    expect(writes).toEqual([]);
  });
  it('does not download unchanged credentials on each account-list refresh', async () => {
    const { manager, fetcher } = await setup();
    await manager.register(input());
    fetcher.mockClear();
    await manager.getAccounts();
    await manager.getAccounts();
    expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/credential'))).toHaveLength(
      0,
    );
  });
  it('rejects queued owner-A input after logout/login as B before the queue starts', async () => {
    const { manager, client, fetcher, store, writes } = await setup();
    await manager.register(input());
    const original = fetcher.getMockImplementation()!;
    let complete!: () => void;
    let blocked = false;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/threads/accounts') && init?.method === 'GET' && !blocked) {
        blocked = true;
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      }
      return original(url, init);
    });
    const reading = manager.getAccounts();
    await vi.waitFor(() => expect(blocked).toBe(true));
    const queued = manager.register(input('456'));
    await vi.waitFor(() =>
      expect(
        fetcher.mock.calls.filter(([url]) => String(url).endsWith('/access')).length,
      ).toBeGreaterThanOrEqual(3),
    );
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    complete();
    expect((await reading).accounts).toEqual([]);
    const rejected = await queued;
    expect(rejected.status).toBe('error');
    expect(rejected.accounts).toEqual([]);
    expect(writes).toEqual(['POST']);
    expect(await store.read(scope, 'b')).toEqual([]);
    expect((await store.read(scope, 'a')).map((r) => r.appName)).toEqual(['123']);
  });
  it('registers a human-readable Meta app name with a generated durable identity and no numeric App ID', async () => {
    const { manager, fetcher, store } = await setup();
    const result = await manager.register({
      appName: ' 나의 뷰티 앱 ',
      label: ' my_threads ',
      token: 'test-secret',
    });
    expect(result.status).toBe('ok');
    const row = result.accounts[0];
    expect(row).toMatchObject({ appName: '나의 뷰티 앱', label: 'my_threads', appId: null });
    expect(row.registrationId).toMatch(/^[0-9a-f-]{36}$/);
    const mutation = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(JSON.parse(mutation[1]!.body as string)).toEqual({
      registrationId: row.registrationId,
      appName: '나의 뷰티 앱',
      label: 'my_threads',
      token: 'test-secret',
    });
    expect((await store.read(scope, 'a'))[0].registrationId).toBe(row.registrationId);
  });
  it('keeps the same durable identity across explicit retries', async () => {
    const { manager, reject, fetcher } = await setup();
    reject(true);
    const failed = await manager.register(input());
    reject(false);
    const retried = await manager.retry({ localId: failed.accounts[0].localId });
    const bodies = fetcher.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toHaveLength(2);
    expect(bodies[0].registrationId).toBe(bodies[1].registrationId);
    expect(retried.accounts[0].registrationId).toBe(bodies[0].registrationId);
  });
  it('blocks blind creation of a migrated unresolved App ID registration', async () => {
    const { manager, store, writes } = await setup();
    await store.write(scope, 'a', [legacyRecord()]);
    const read = await manager.getAccounts();
    expect(read.accounts[0].localState).toBe('conflict');
    const retry = await manager.retry({ localId: 'legacy-local' });
    expect(retry.problem?.code).toBe('LEGACY_REGISTRATION_PENDING');
    expect((await store.read(scope, 'a'))[0].pending?.token).toBe('legacy-secret');
    expect(writes).toEqual([]);
    expect((await manager.discardPending({ localId: 'legacy-local' })).accounts).toEqual([]);
  });
  it('reconciles legacy ambiguous creation only using its old App ID and exact token', async () => {
    const { manager, store, writes, server } = await setup();
    await store.write(scope, 'a', [legacyRecord()]);
    server.set('legacy-server', legacyRemote('legacy-secret'));
    const read = await manager.getAccounts();
    expect(read.accounts).toHaveLength(1);
    expect(read.accounts[0]).toMatchObject({
      localId: 'legacy-local',
      registrationId: 'legacy-server',
      localState: 'synced',
    });
    const record = (await store.read(scope, 'a'))[0];
    expect(record.legacyAppId).toBeNull();
    expect(record.syncedToken).toBe('legacy-secret');
    expect(writes).toEqual([]);
  });
  it('does not merge a legacy pending token into an account with different canonical credentials', async () => {
    const { manager, store, writes, server } = await setup();
    await store.write(scope, 'a', [legacyRecord()]);
    server.set('legacy-server', legacyRemote('remote-secret'));
    const read = await manager.getAccounts();
    expect(read.accounts).toHaveLength(2);
    expect(read.accounts.find((r) => r.localId === 'legacy-local')).toMatchObject({
      account: null,
      localState: 'conflict',
    });
    expect(read.accounts.find((r) => r.registrationId === 'legacy-server')).toMatchObject({
      localState: 'synced',
    });
    const retry = await manager.retry({ localId: 'legacy-local' });
    expect(retry.problem?.code).toBe('LEGACY_REGISTRATION_PENDING');
    expect(writes).toEqual([]);
  });
  it('fetches canonical credentials if idempotent creation races a mobile revision advance', async () => {
    const { manager, fetcher, server, store, writes } = await setup();
    const original = fetcher.getMockImplementation()!;
    let raced = false;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/threads/accounts') && init?.method === 'POST' && !raced) {
        raced = true;
        const body = JSON.parse(init.body as string);
        server.set('raced-server', {
          account: {
            ...legacyRemote('mobile-secret').account,
            id: 'raced-server',
            registrationId: body.registrationId,
            appName: body.appName,
            label: body.label,
            appId: null,
            tokenRevision: 2,
          },
          token: 'mobile-secret',
        });
      }
      return original(url, init);
    });
    const result = await manager.register(input());
    expect(result.problem?.code).toBe('STALE_CREDENTIAL');
    expect(result.accounts[0]).toMatchObject({ localState: 'conflict', localRevision: 2 });
    const record = (await store.read(scope, 'a'))[0];
    expect(record.syncedToken).toBe('mobile-secret');
    expect(record.pending?.token).toBe(input().token);
    expect(writes).toEqual(['POST']);
  });
  it('persists explicit deletion intent before DELETE and removes only the confirmed account copy', async () => {
    const { manager, store, server, fetcher } = await setup();
    const initial = await manager.register(input());
    await manager.register(input('other'));
    const target = initial.accounts[0];
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') {
        const persisted = (await store.read(scope, 'a')).find(
          (r) => r.account?.id === target.account!.id,
        )!;
        expect(persisted.pendingDeletion).toEqual({
          expectedRevision: 1,
          expectedLifecycleVersion: 1,
          expectedOwnershipVersion: 1,
        });
        expect(persisted.syncedToken).toBe(input().token);
      }
      return original(url, init);
    });
    const result = await manager.deleteAccount({
      accountId: target.account!.id,
      expectedRevision: 1,
    });
    expect(result.status).toBe('ok');
    expect(result.accounts).toHaveLength(1);
    expect(result.accounts[0].appName).toBe('other');
    expect(await store.read(scope, 'a')).toHaveLength(1);
    expect(server.has(target.account!.id)).toBe(false);
  });
  it('preserves credentials after a failed deletion, never auto-deletes on read and explicitly retries', async () => {
    const { manager, store, reject, writes } = await setup();
    const initial = await manager.register(input());
    const request = { accountId: initial.accounts[0].account!.id, expectedRevision: 1 };
    reject(true);
    const failed = await manager.deleteAccount(request);
    expect(failed.accounts[0].pendingDeletion).toBe(true);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    reject(false);
    expect((await manager.getAccounts()).accounts[0].pendingDeletion).toBe(true);
    expect(writes).toEqual(['POST', 'DELETE']);
    expect((await manager.replace({ ...request, token: 'replacement' })).problem?.code).toBe(
      'DELETION_PENDING',
    );
    expect(
      (await manager.discardPending({ localId: initial.accounts[0].localId })).problem?.code,
    ).toBe('DELETION_PENDING');
    expect((await manager.deleteAccount(request)).accounts).toEqual([]);
    expect(writes).toEqual(['POST', 'DELETE', 'DELETE']);
  });
  it('cleans a lost successful deletion on tombstone refresh without repeating DELETE', async () => {
    const { manager, store, lose, writes } = await setup();
    const initial = await manager.register(input());
    lose(true);
    const failed = await manager.deleteAccount({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
    });
    expect(failed.accounts[0].pendingDeletion).toBe(true);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    lose(false);
    expect((await manager.getAccounts()).accounts).toEqual([]);
    expect(await store.read(scope, 'a')).toEqual([]);
    expect(writes).toEqual(['POST', 'DELETE']);
  });
  it('cleans another-PC deletion by registration ID even when create success never reached this PC', async () => {
    const { manager, store, lose, writes, server, deleted } = await setup();
    lose(true);
    const pending = await manager.register(input());
    expect(pending.accounts[0].account).toBeNull();
    const remote = [...server.values()][0].account;
    deleted.set(remote.id, {
      id: remote.id,
      registrationId: remote.registrationId,
      ownerId: 'a',
      deletedAt: '2026-10-19T01:00:00.000Z',
    });
    server.delete(remote.id);
    lose(false);
    const retry = await manager.retry({ localId: pending.accounts[0].localId });
    expect(retry.status).toBe('ok');
    expect(retry.accounts).toEqual([]);
    expect(await store.read(scope, 'a')).toEqual([]);
    expect(writes).toEqual(['POST']);
  });
  it('never infers deletion or erases a credential merely because the server list is missing it', async () => {
    const { manager, store, server } = await setup();
    await manager.register(input());
    server.clear();
    const read = await manager.getAccounts();
    expect(read.accounts[0].localState).toBe('missing');
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('requires explicit reconfirmation when the deletion revision changed and keeps canonical credentials', async () => {
    const { manager, store, server, writes } = await setup();
    const initial = await manager.register(input());
    const id = initial.accounts[0].account!.id;
    server.get(id)!.account.tokenRevision = 2;
    server.get(id)!.token = 'mobile-latest';
    const result = await manager.deleteAccount({ accountId: id, expectedRevision: 1 });
    expect(result.problem?.code).toBe('DELETE_CONFLICT');
    expect(result.accounts[0]).toMatchObject({ localRevision: 2, pendingDeletion: false });
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe('mobile-latest');
    expect(writes).toEqual(['POST']);
    expect((await manager.deleteAccount({ accountId: id, expectedRevision: 2 })).accounts).toEqual(
      [],
    );
  });
  it('clears a stale deletion intent on a confirmed active newer revision without resending DELETE', async () => {
    const { manager, store, server, reject, writes } = await setup();
    const initial = await manager.register(input());
    const id = initial.accounts[0].account!.id;
    reject(true);
    await manager.deleteAccount({ accountId: id, expectedRevision: 1 });
    reject(false);
    server.get(id)!.account.tokenRevision = 2;
    server.get(id)!.token = 'mobile-refreshed';
    const refreshed = await manager.getAccounts();
    expect(refreshed.accounts[0]).toMatchObject({ localRevision: 2, pendingDeletion: false });
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe('mobile-refreshed');
    expect(writes).toEqual(['POST', 'DELETE']);
  });
  it('clears an explicitly rejected deletion after a race and requires a fresh confirmation', async () => {
    const { manager, store, server, fetcher, writes } = await setup();
    const initial = await manager.register(input());
    const id = initial.accounts[0].account!.id;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      if (init?.method === 'DELETE') {
        server.get(id)!.account.tokenRevision = 2;
        server.get(id)!.token = 'concurrent-token';
      }
      return original(url, init);
    });
    const failed = await manager.deleteAccount({ accountId: id, expectedRevision: 1 });
    expect(failed.problem?.code).toBe('DELETE_CONFLICT');
    expect(failed.accounts[0].pendingDeletion).toBe(false);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    expect((await manager.getAccounts()).accounts[0].localRevision).toBe(2);
    expect(writes).toEqual(['POST', 'DELETE']);
  });
  it('purges a confirmed tombstone even if another account credential fetch fails', async () => {
    const { manager, store, server, deleted, fetcher } = await setup();
    const initial = await manager.register(input());
    const second = await manager.register(input('second'));
    const removed = initial.accounts[0].account!;
    const otherId = second.accounts.find((r) => r.account!.id !== removed.id)!.account!.id;
    deleted.set(removed.id, {
      id: removed.id,
      registrationId: removed.registrationId,
      ownerId: 'a',
      deletedAt: '2026-10-19T01:00:00.000Z',
    });
    server.delete(removed.id);
    server.get(otherId)!.account.tokenRevision = 2;
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) =>
      String(url).endsWith(`/${otherId}/credential`)
        ? Promise.resolve(json({}, 503))
        : original(url, init),
    );
    const result = await manager.getAccounts();
    expect(result.problem?.code).toBe('SERVICE_UNAVAILABLE');
    expect(result.accounts.map((r) => r.account!.id)).toEqual([otherId]);
    expect((await store.read(scope, 'a')).map((r) => r.account!.id)).toEqual([otherId]);
  });
  it('retains the local encrypted copy on a bare delete 404 without an explicit tombstone', async () => {
    const { manager, store, server } = await setup();
    const initial = await manager.register(input());
    server.clear();
    const result = await manager.deleteAccount({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
    });
    expect(result.problem?.code).toBe('NOT_FOUND');
    expect(result.accounts[0].pendingDeletion).toBe(true);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('rejects malformed deletion input and another employee account without transmitting DELETE', async () => {
    const { manager, client, writes } = await setup();
    const initial = await manager.register(input());
    const accountId = initial.accounts[0].account!.id;
    for (const body of [
      { accountId: '../account', expectedRevision: 1 },
      { accountId, expectedRevision: 0 },
      { accountId, expectedRevision: 1, ownerId: 'other' },
      { accountId, expectedRevision: 1, token: 'must-not-send' },
    ])
      expect((await manager.deleteAccount(body)).problem?.code).toBe('VALIDATION_FAILED');
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    expect((await manager.deleteAccount({ accountId, expectedRevision: 1 })).problem?.code).toBe(
      'NOT_FOUND',
    );
    expect(writes).toEqual(['POST']);
  });
  it('allows a fresh registration after confirmed deletion without resurrecting the old identity', async () => {
    const { manager, store } = await setup();
    const initial = await manager.register(input());
    const old = initial.accounts[0];
    await manager.deleteAccount({ accountId: old.account!.id, expectedRevision: 1 });
    const reconnected = await manager.register({ ...input(), token: 'new-long-lived-token' });
    expect(reconnected.status).toBe('ok');
    expect(reconnected.accounts).toHaveLength(1);
    expect(reconnected.accounts[0].registrationId).not.toBe(old.registrationId);
    expect(reconnected.accounts[0].account!.id).not.toBe(old.account!.id);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe('new-long-lived-token');
    expect(JSON.stringify(reconnected)).not.toContain('new-long-lived-token');
  });
  it('reports a pending DB migration distinctly and preserves the encrypted account', async () => {
    const { manager, store, fetcher } = await setup();
    await manager.register(input());
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation((url, init) =>
      String(url).endsWith('/threads/accounts')
        ? Promise.resolve(
            json({ error: { code: 'MIGRATION_REQUIRED', message: 'database-secret' } }, 503),
          )
        : original(url, init),
    );
    const result = await manager.getAccounts();
    expect(result.problem).toEqual({
      code: 'MIGRATION_REQUIRED',
      message: '계정 관리 DB 업데이트가 필요합니다. 관리자에게 문의해 주세요.',
    });
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    expect(JSON.stringify(result)).not.toMatch(/database-secret|private-token/);
  });
  it('purges another-PC deletion on authenticated access while the account modal is closed without fetching credentials or replaying pending input', async () => {
    const { manager, store, client, server, deleted, fetcher, writes, reject } = await setup();
    const initial = await manager.register(input());
    const removed = initial.accounts[0].account!;
    reject(true);
    await manager.register(input('unsent'));
    reject(false);
    deleted.set(removed.id, {
      id: removed.id,
      registrationId: removed.registrationId,
      ownerId: 'a',
      deletedAt: '2026-10-19T01:00:00.000Z',
    });
    server.delete(removed.id);
    fetcher.mockClear();
    let cleanup = Promise.resolve();
    const access = new ServiceAccess(client, (state) => {
      if (state.status === 'authenticated' && !state.mustChangePassword)
        cleanup = manager.reconcileDeletedAccounts(state.user.id, 1);
    });
    expect(await access.allowed()).toBe(true);
    await cleanup;
    const retained = await store.read(scope, 'a');
    expect(retained).toHaveLength(1);
    expect(retained[0].pending?.token).toBe('private-token-unsent');
    expect(retained[0].account).toBeNull();
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith('/credential'))).toBe(false);
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    expect(writes).toEqual(['POST', 'POST']);
  });
  it('coalesces concurrent authenticated cleanup checks and preserves files on list failure for a later retry', async () => {
    const { manager, store, fetcher } = await setup();
    await manager.register(input());
    const original = fetcher.getMockImplementation()!;
    let finish!: () => void;
    let listCalls = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/threads/accounts')) {
        listCalls += 1;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return json({}, 503);
      }
      return original(url, init);
    });
    const first = manager.reconcileDeletedAccounts('a', 1);
    const same = manager.reconcileDeletedAccounts('a', 1);
    expect(same).toBe(first);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    finish();
    await Promise.all([first, same]);
    expect(listCalls).toBe(1);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    fetcher.mockImplementation(original);
    const retry = manager.reconcileDeletedAccounts('a', 1);
    expect(retry).not.toBe(first);
    await retry;
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('does not apply a stale authenticated cleanup response after logout and switching owners', async () => {
    const { manager, store, client, server, deleted, fetcher } = await setup();
    const initial = await manager.register(input());
    const removed = initial.accounts[0].account!;
    deleted.set(removed.id, {
      id: removed.id,
      registrationId: removed.registrationId,
      ownerId: 'a',
      deletedAt: '2026-10-19T01:00:00.000Z',
    });
    server.delete(removed.id);
    const original = fetcher.getMockImplementation()!;
    let finish!: () => void;
    fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/threads/accounts'))
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return response;
    });
    const stale = manager.reconcileDeletedAccounts('a', 1);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    finish();
    await stale;
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    expect(await store.read(scope, 'b')).toEqual([]);
    fetcher.mockImplementation(original);
    await manager.reconcileDeletedAccounts('a', 1);
    expect(await store.read(scope, 'b')).toEqual([]);
    await manager.reconcileDeletedAccounts('b', 2);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('does not send DELETE unless its intent is durably encrypted first', async () => {
    const { manager, store, client, writes } = await setup();
    const initial = await manager.register(input());
    const guarded = new ManagedThreadsManager(
      client,
      {
        read: store.read.bind(store),
        write: async (service, owner, records) => {
          if (records.some((r) => r.pendingDeletion))
            throw new ManagedThreadsStorageError('STORAGE_WRITE_FAILED');
          return store.write(service, owner, records);
        },
      },
      scope,
    );
    const result = await guarded.deleteAccount({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
    });
    expect(result.problem?.code).toBe('STORAGE_WRITE_FAILED');
    expect(writes).toEqual(['POST']);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('retains the encrypted copy when cleanup failed after server deletion and then cleans on refresh', async () => {
    const { manager, store, client, writes } = await setup();
    const initial = await manager.register(input());
    const guarded = new ManagedThreadsManager(
      client,
      {
        read: store.read.bind(store),
        write: async (service, owner, records) => {
          if (records.length === 0) throw new ManagedThreadsStorageError('STORAGE_WRITE_FAILED');
          return store.write(service, owner, records);
        },
      },
      scope,
    );
    const result = await guarded.deleteAccount({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
    });
    expect(result.problem?.code).toBe('LOCAL_DELETE_SYNC_PENDING');
    expect(result.accounts[0].pendingDeletion).toBe(true);
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
    expect((await manager.getAccounts()).accounts).toEqual([]);
    expect(writes).toEqual(['POST', 'DELETE']);
  });
  it('rejects inconsistent tombstones and preserves the encrypted credential', async () => {
    const { manager, store, server, deleted } = await setup();
    const initial = await manager.register(input());
    const account = initial.accounts[0].account!;
    server.delete(account.id);
    deleted.set(account.id, {
      id: account.id,
      registrationId: 'different-registration',
      ownerId: 'a',
      deletedAt: '2026-10-19T01:00:00.000Z',
    });
    expect((await manager.getAccounts()).problem?.code).toBe('INVALID_RESPONSE');
    expect((await store.read(scope, 'a'))[0].syncedToken).toBe(input().token);
  });
  it('drops an in-flight deletion response crossing logout without touching the next owner data', async () => {
    const { manager, store, client, fetcher } = await setup();
    const initial = await manager.register(input());
    const original = fetcher.getMockImplementation()!;
    let complete!: () => void;
    fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (init?.method === 'DELETE')
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      return response;
    });
    const deleting = manager.deleteAccount({
      accountId: initial.accounts[0].account!.id,
      expectedRevision: 1,
    });
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    complete();
    const result = await deleting;
    expect(result.problem?.code).toBe('AUTH_CHANGED');
    expect(result.accounts).toEqual([]);
    expect((await store.read(scope, 'a'))[0].pendingDeletion).toEqual({
      expectedRevision: 1,
      expectedLifecycleVersion: 1,
      expectedOwnershipVersion: 1,
    });
    expect(await store.read(scope, 'b')).toEqual([]);
  });
  it('drops an in-flight success crossing logout and preserves only the original owner pending state', async () => {
    const { manager, client, fetcher, store } = await setup();
    const original = fetcher.getMockImplementation()!;
    let complete!: () => void;
    fetcher.mockImplementation(async (url, init) => {
      const response = await original(url, init);
      if (String(url).endsWith('/threads/accounts') && init?.method === 'POST')
        await new Promise<void>((resolve) => {
          complete = resolve;
        });
      return response;
    });
    const posting = manager.register(input());
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    await client.signOut();
    await client.signIn('employee-b', 'password-123');
    complete();
    const result = await posting;
    expect(result.problem?.code).toBe('AUTH_CHANGED');
    expect(result.accounts).toEqual([]);
    expect((await store.read(scope, 'a'))[0].pending?.token).toBe(input().token);
    expect(await store.read(scope, 'b')).toEqual([]);
  });
});
