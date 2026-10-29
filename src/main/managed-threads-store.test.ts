import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { TokenCipher } from './auth-token-store';
import {
  EncryptedManagedThreadsStore,
  parseManagedAccount,
  type ManagedThreadsRecord,
} from './managed-threads-store';

export class SecureTestCipher implements TokenCipher {
  private readonly key = randomBytes(32);
  async isEncryptionAvailable() {
    return true;
  }
  async encryptString(value: string) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
  }
  async decryptString(value: Buffer) {
    const decipher = createDecipheriv('aes-256-gcm', this.key, value.subarray(0, 12));
    decipher.setAuthTag(value.subarray(12, 28));
    return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString('utf8');
  }
}
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'managed-store-'));
  directories.push(dir);
  const file = join(dir, 'accounts.bin');
  const cipher = new SecureTestCipher();
  return { file, cipher, store: new EncryptedManagedThreadsStore(file, cipher) };
}
const record = (id: string, appName: string): ManagedThreadsRecord => ({
  localId: id,
  label: '나의 계정',
  registrationId: `registration-${id}`,
  appName,
  appId: null,
  legacyAppId: null,
  account: null,
  syncedToken: null,
  pending: { action: 'create', token: `secret-${id}`, expectedRevision: null },
  pendingDeletion: null,
  conflict: false,
  missing: false,
});

describe('encrypted managed account store', () => {
  it('encrypts the whole file mode 0600 and partitions two users and two service origins', async () => {
    const { file, store } = await setup();
    await Promise.all([
      store.write('https://dev.example', 'a', [record('a1', '1'), record('a2', '2')]),
      store.write('https://dev.example', 'b', [record('b1', '3')]),
      store.write('https://prod.example', 'a', [record('prod', '4')]),
    ]);
    expect((await readFile(file)).toString()).not.toMatch(/secret|나의 계정|https|partitions/);
    if (process.platform !== 'win32') expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect((await store.read('https://dev.example', 'a')).map((r) => r.localId)).toEqual([
      'a1',
      'a2',
    ]);
    expect((await store.read('https://dev.example', 'b')).map((r) => r.localId)).toEqual(['b1']);
    expect(await store.read('https://elsewhere.example', 'a')).toEqual([]);
  });
  it('preserves corrupt encrypted data and never replaces it on write', async () => {
    const { file, store } = await setup();
    const damaged = Buffer.from('damaged existing ciphertext');
    await writeFile(file, damaged);
    await expect(store.read('scope', 'a')).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    await expect(store.write('scope', 'a', [record('a1', '1')])).rejects.toMatchObject({
      code: 'STORAGE_CORRUPT',
    });
    expect(await readFile(file)).toEqual(damaged);
  });
  it('refuses malformed decrypted structure without automatic repair', async () => {
    const { file, cipher, store } = await setup();
    const original = await cipher.encryptString(
      JSON.stringify({
        version: 1,
        partitions: [{ scope: 'scope', ownerId: 'a', records: [{ token: 'secret' }] }],
      }),
    );
    await writeFile(file, original);
    await expect(store.write('scope', 'a', [])).rejects.toMatchObject({ code: 'STORAGE_CORRUPT' });
    expect(await readFile(file)).toEqual(original);
  });
  it('migrates v1 synced and ambiguous pending records without losing encrypted tokens', async () => {
    const { file, cipher, store } = await setup();
    const oldAccount = {
      id: 'server-id',
      ownerId: 'a',
      label: '예전 계정',
      appId: '123',
      threadsUserId: null,
      validationStatus: 'pending_validation',
      tokenRevision: 2,
      expiresAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    const old = {
      localId: 'old-local',
      label: '예전 계정',
      appId: '123',
      account: oldAccount,
      syncedToken: 'old-synced-secret',
      pending: { action: 'replace', token: 'old-pending-secret', expectedRevision: 2 },
      conflict: false,
      missing: false,
    };
    const pending = {
      ...old,
      localId: 'old-pending',
      appId: '456',
      account: null,
      syncedToken: null,
      pending: { action: 'create', token: 'ambiguous-secret', expectedRevision: null },
    };
    const original = await cipher.encryptString(
      JSON.stringify({
        version: 1,
        partitions: [{ scope: 'scope', ownerId: 'a', records: [old, pending] }],
      }),
    );
    await writeFile(file, original);
    const records = await store.read('scope', 'a');
    expect(await readFile(file)).toEqual(original);
    expect(records[0]).toMatchObject({
      registrationId: 'server-id',
      appName: '123',
      legacyAppId: null,
      syncedToken: 'old-synced-secret',
      pending: { token: 'old-pending-secret' },
    });
    expect(records[0].account).toMatchObject({
      registrationId: 'server-id',
      appName: '123',
      appId: '123',
    });
    expect(records[1]).toMatchObject({
      registrationId: 'old-pending',
      appName: '456',
      legacyAppId: '456',
      pending: { token: 'ambiguous-secret' },
    });
    await store.write('scope', 'a', records);
    const decrypted = JSON.parse(await cipher.decryptString(await readFile(file)));
    expect(decrypted.version).toBe(4);
    expect(await store.read('scope', 'a')).toEqual(records);
    expect((await readFile(file)).toString()).not.toContain('secret');
  });
  it('allows duplicate display names while rejecting duplicate stable registration IDs', async () => {
    const { store } = await setup();
    await store.write('scope', 'a', [record('one', '같은 앱'), record('two', '같은 앱')]);
    expect(await store.read('scope', 'a')).toHaveLength(2);
    await expect(
      store.write('scope', 'a', [
        record('one', '앱1'),
        { ...record('two', '앱2'), registrationId: 'registration-one' },
      ]),
    ).rejects.toThrow('duplicate record');
    expect(await store.read('scope', 'a')).toHaveLength(2);
  });
  it('upgrades v2 without erasing pending credentials', async () => {
    const { file, cipher, store } = await setup();
    const old = Object.fromEntries(
      Object.entries(record('pending', '앱')).filter(([key]) => key !== 'pendingDeletion'),
    );
    const original = await cipher.encryptString(
      JSON.stringify({
        version: 2,
        partitions: [{ scope: 'scope', ownerId: 'a', records: [old] }],
      }),
    );
    await writeFile(file, original);
    const migrated = await store.read('scope', 'a');
    expect(migrated[0].pendingDeletion).toBeNull();
    expect(migrated[0].pending?.token).toBe('secret-pending');
    expect(await readFile(file)).toEqual(original);
    await store.write('scope', 'a', migrated);
    expect(JSON.parse(await cipher.decryptString(await readFile(file))).version).toBe(4);
  });
  it('round-trips a v3 deletion intent with both synced and pending encrypted tokens intact', async () => {
    const { file, store } = await setup();
    const pending = record('registered', '운동 앱');
    const account = {
      id: 'server-id',
      ownerId: 'a',
      label: pending.label,
      registrationId: pending.registrationId,
      appName: pending.appName,
      appId: null,
      threadsUserId: null,
      validationStatus: 'pending_validation' as const,
      tokenRevision: 2,
      expiresAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    const deleting: ManagedThreadsRecord = {
      ...pending,
      account,
      syncedToken: 'synced-private-token',
      pending: { action: 'replace', token: 'pending-private-token', expectedRevision: 2 },
      pendingDeletion: { expectedRevision: 2 },
    };
    await store.write('scope', 'a', [deleting]);
    expect(await store.read('scope', 'a')).toEqual([deleting]);
    expect((await readFile(file)).toString()).not.toContain('private-token');
  });
  it('keeps a checked pending token and its reason in file version 4 and rejects bad shapes', async () => {
    const { file, cipher, store } = await setup();
    const account = {
      id: 'server-id',
      ownerId: 'a',
      label: '나의 계정',
      registrationId: 'registration-checked',
      appName: '앱',
      appId: null,
      threadsUserId: '1234',
      validationStatus: 'reported_valid' as const,
      tokenRevision: 3,
      expiresAt: '2026-11-07T00:00:00.000Z',
      createdAt: '2026-10-19T00:00:00.000Z',
    };
    const verification = { threadsUserId: '1234', expiresAt: '2026-12-27T00:00:00.000Z' };
    const refreshed: ManagedThreadsRecord = {
      ...record('checked', '앱'),
      account,
      syncedToken: 'old-private-token',
      pending: {
        action: 'replace',
        token: 'refreshed-private-token',
        expectedRevision: 3,
        verification,
        reason: 'refresh',
      },
    };
    const created = {
      ...record('created', '앱'),
      pending: { ...record('created', '앱').pending!, verification },
    };
    await store.write('scope', 'a', [refreshed, created]);
    expect(await store.read('scope', 'a')).toEqual([refreshed, created]);
    const saved = JSON.parse(await cipher.decryptString(await readFile(file)));
    expect(saved.version).toBe(4);
    for (const pending of [
      { ...refreshed.pending, reason: 'transfer' },
      { ...refreshed.pending, verification: { ...verification, threadsUserId: 'me' } },
      { ...refreshed.pending, verification: { ...verification, expiresAt: '2026-12-27' } },
      { ...refreshed.pending, verification: { ...verification, token: 'x' } },
      { ...created.pending, reason: 'replace' },
    ])
      await expect(
        store.write('scope', 'a', [{ ...refreshed, pending } as ManagedThreadsRecord]),
      ).rejects.toThrow('invalid pending');
    expect(await store.read('scope', 'a')).toEqual([refreshed, created]);
  });
  it('has no plaintext fallback if the OS keyring is unavailable', async () => {
    const { file, cipher } = await setup();
    cipher.isEncryptionAvailable = async () => false;
    const store = new EncryptedManagedThreadsStore(file, cipher);
    await expect(store.write('scope', 'a', [record('a1', '1')])).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    });
    await expect(lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

it('reads legacy v3 without altering token and deletion intent records', async () => {
  const { file, cipher, store } = await setup();
  const existing = record('pending-old', '기존 앱');
  const original = await cipher.encryptString(
    JSON.stringify({
      version: 3,
      partitions: [{ scope: 'scope', ownerId: 'a', records: [existing] }],
    }),
  );
  await writeFile(file, original);
  expect(await store.read('scope', 'a')).toEqual([existing]);
  expect(await readFile(file)).toEqual(original);
  await store.write('scope', 'a', [existing]);
  const migrated = JSON.parse(await cipher.decryptString(await readFile(file)));
  expect(migrated.version).toBe(4);
  expect(migrated.partitions[0].operations).toEqual([]);
  expect(migrated.partitions[0].records).toEqual([existing]);
});
it('retires every v4 lifecycle intent without erasing tokens or existing create/replace/delete work', async () => {
  const { file, cipher, store } = await setup();
  const existing = record('legacy-pending', '기존 앱');
  const operations = ['suspend', 'resume', 'transfer', 'accept', 'reject', 'cancel'].map(
    (action, index) => ({
      operationId: `retired-${index}`,
      action,
      accountId: 'owned-account',
      transferId: 'old-transfer',
      recipientUserId: 'other',
      expectedLifecycleVersion: 2,
      expectedOwnershipVersion: 1,
    }),
  );
  const original = await cipher.encryptString(
    JSON.stringify({
      version: 4,
      partitions: [{ scope: 'scope', ownerId: 'a', records: [existing], operations }],
    }),
  );
  await writeFile(file, original);
  expect(await store.read('scope', 'a')).toEqual([existing]);
  expect(await readFile(file)).toEqual(original);
  await store.write('scope', 'a', [existing]);
  const migrated = JSON.parse(await cipher.decryptString(await readFile(file)));
  expect(migrated.partitions[0].operations).toEqual([]);
  expect(migrated.partitions[0].records[0].pending.token).toBe('secret-legacy-pending');
  expect(JSON.stringify(migrated)).not.toContain('retired-');
});

it('reads a server account without appId and appIdVerified, which the server dropped after 0.1.8', () => {
  const account = parseManagedAccount(
    {
      id: 'server-1',
      ownerId: 'owner-1',
      label: '뷰티 계정',
      registrationId: 'registration-1',
      appName: '뷰티 마케팅 앱',
      threadsUserId: null,
      validationStatus: 'pending_validation',
      tokenRevision: 1,
      expiresAt: null,
      createdAt: '2026-10-19T00:00:00.000Z',
    },
    'owner-1',
  );
  expect(account.appId).toBeNull();
  expect('appIdVerified' in account).toBe(false);
});
