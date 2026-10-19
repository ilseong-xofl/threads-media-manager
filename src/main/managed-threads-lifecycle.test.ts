import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedThreadsAccount } from '../shared/managed-threads';
import { EncryptedManagedThreadsStore } from './managed-threads-store';
import { ManagedThreadsManager } from './managed-threads';
import { ServiceApiClient } from './service-api';

const scope = 'https://service.example.test',
  date = '2026-10-19T00:00:00.000Z';
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
const json = (value: unknown) => new Response(JSON.stringify(value));
async function setup() {
  let account: ManagedThreadsAccount = {
    id: 'account',
    ownerId: 'a',
    registrationId: 'grant-a-1',
    label: '계정',
    appName: '앱',
    appId: null,
    threadsUserId: null,
    validationStatus: 'pending_validation',
    appIdVerified: false,
    tokenRevision: 1,
    expiresAt: null,
    createdAt: date,
    lifecycleVersion: 1,
    ownershipVersion: 1,
  };
  let remoteToken = 'token-private';
  const dir = await mkdtemp(join(tmpdir(), 'managed-policy-'));
  dirs.push(dir);
  const file = join(dir, 'encrypted.bin');
  const cipher = {
    isEncryptionAvailable: async () => true,
    encryptString: async (s: string) => Buffer.from(Buffer.from(s).map((b) => b ^ 47)),
    decryptString: async (b: Buffer) => Buffer.from(b.map((c) => c ^ 47)).toString(),
  };
  const store = new EncryptedManagedThreadsStore(file, cipher);
  const requests: { path: string; method: string }[] = [];
  const client = new ServiceApiClient(
    scope,
    { read: async () => 'session-a', write: async () => {}, clear: async () => {} },
    async (url, init) => {
      expect(new URL(String(url)).origin).toBe(scope);
      const path = new URL(String(url)).pathname,
        method = init?.method ?? 'GET';
      requests.push({ path, method });
      if (path === '/api/v1/access')
        return json({
          user: { id: 'a', displayName: 'a', email: 'a@ilscp.net' },
          mustChangePassword: false,
          permissions: { app: true },
        });
      if (path === '/api/v1/threads/accounts')
        return json({ accounts: [account], deletedAccounts: [] });
      if (path.endsWith('/credential')) return json({ account, token: remoteToken });
      throw new Error('Unexpected request');
    },
  );
  const manager = new ManagedThreadsManager(client, store, scope);
  return {
    manager,
    store,
    client,
    requests,
    file,
    cipher,
    get account() {
      return account;
    },
    set account(v: ManagedThreadsAccount) {
      account = v;
    },
    token: (v: string) => {
      remoteToken = v;
    },
  };
}

describe('account policy after retired lifecycle features', () => {
  it('refuses an old deletion intent after a historical version change even with an unchanged token revision', async () => {
    const f = await setup();
    await f.manager.getAccounts();
    const records = await f.store.read(scope, 'a');
    records[0].pendingDeletion = {
      expectedRevision: 1,
      expectedLifecycleVersion: 1,
      expectedOwnershipVersion: 1,
    };
    await f.store.write(scope, 'a', records);
    f.account = { ...f.account, lifecycleVersion: 3 };
    expect(
      (await f.manager.deleteAccount({ accountId: f.account.id, expectedRevision: 1 })).problem
        ?.code,
    ).toBe('DELETE_CONFLICT');
    expect(f.requests.filter((r) => r.method === 'DELETE')).toEqual([]);
    expect((await f.store.read(scope, 'a'))[0].pendingDeletion).toBeNull();
    expect((await f.store.read(scope, 'a'))[0].syncedToken).toBe('token-private');
  });
  it('expires a legacy v3 deletion intent instead of adopting the newest version', async () => {
    const f = await setup();
    await f.manager.getAccounts();
    const records = await f.store.read(scope, 'a');
    records[0].pendingDeletion = { expectedRevision: 1 };
    await f.store.write(scope, 'a', records);
    f.account = { ...f.account, lifecycleVersion: 2 };
    expect((await f.manager.getAccounts()).status).toBe('ok');
    expect((await f.store.read(scope, 'a'))[0].pendingDeletion).toBeNull();
    expect(f.requests.every((r) => r.method === 'GET')).toBe(true);
  });
  it('downloads the canonical token if cached metadata and cached token revisions differ', async () => {
    const f = await setup();
    await f.manager.getAccounts();
    const records = await f.store.read(scope, 'a');
    records[0].account = { ...records[0].account!, tokenRevision: 2 };
    records[0].syncedRevision = 1;
    await f.store.write(scope, 'a', records);
    f.account = { ...f.account, tokenRevision: 2 };
    f.token('new-mobile-token');
    expect((await f.manager.getAccounts()).status).toBe('ok');
    const saved = (await f.store.read(scope, 'a'))[0];
    expect(saved.syncedToken).toBe('new-mobile-token');
    expect(saved.syncedRevision).toBe(2);
  });
  it('does not expose retired state methods or change ownership while synchronizing', async () => {
    const f = await setup();
    const result = await f.manager.getAccounts();
    for (const key of ['setStatus', 'retryOperation', 'requestTransfer', 'respondTransfer'])
      expect(f.manager).not.toHaveProperty(key);
    for (const key of ['pendingOperations', 'transfers', 'recipients'])
      expect(result).not.toHaveProperty(key);
    expect(result.accounts[0].account?.ownerId).toBe('a');
    expect(result.accounts[0].account?.registrationId).toBe('grant-a-1');
    expect(
      f.requests.every((r) => !/(operations|suspend|resume|transfer|recipient)/.test(r.path)),
    ).toBe(true);
  });
  it('discards all retired v4 intents before any network activity while retaining pending token input', async () => {
    const f = await setup();
    await f.manager.getAccounts();
    const records = await f.store.read(scope, 'a');
    records[0].pending = { action: 'replace', token: 'pending-private', expectedRevision: 1 };
    const operations = ['suspend', 'resume', 'transfer', 'accept', 'reject', 'cancel'].map(
      (action, index) => ({
        operationId: `old-${index}`,
        action,
        accountId: 'account',
        registrationId: 'grant-a-1',
        expectedLifecycleVersion: 1,
        expectedOwnershipVersion: 1,
      }),
    );
    await writeFile(
      f.file,
      await f.cipher.encryptString(
        JSON.stringify({ version: 4, partitions: [{ scope, ownerId: 'a', records, operations }] }),
      ),
    );
    const count = f.requests.length;
    const result = await f.manager.getAccounts();
    expect(result.status).toBe('ok');
    expect(result.accounts[0].pendingAction).toBe('replace');
    expect(
      f.requests
        .slice(count)
        .every(
          (r) => r.method === 'GET' && !/operations|suspend|resume|transfer|recipient/.test(r.path),
        ),
    ).toBe(true);
    const migrated = JSON.parse(await f.cipher.decryptString(await readFile(f.file)));
    expect(migrated.partitions[0].operations).toEqual([]);
    expect(migrated.partitions[0].records[0].pending.token).toBe('pending-private');
  });
});
