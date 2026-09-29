import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ThreadsAccountError,
  ThreadsAccountManager,
  type ThreadsAccountClient,
} from './threads-account';
import {
  EncryptedLocalStore,
  SecretStoreError,
  type ThreadsAccountEncryption,
} from './threads-secret-store';

const DAY = 86_400_000;
const FIRST = 'SYNTHETIC_FIRST_TOKEN_123456789';
const SECOND = 'SYNTHETIC_SECOND_TOKEN_123456789';
const dirs: string[] = [];
const key = randomBytes(32);
function encryption(): ThreadsAccountEncryption {
  return {
    isAvailable: () => true,
    encryptString(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(value) {
      const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12));
      cipher.setAuthTag(value.subarray(-16));
      return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString(
        'utf8',
      );
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
async function fixture() {
  const userData = await mkdtemp(join(tmpdir(), 'threads-account-test-'));
  dirs.push(userData);
  let now = Date.parse('2026-09-28T00:00:00.000Z');
  const clock = () => now;
  const crypto = encryption();
  const client: ThreadsAccountClient = {
    debugToken: vi.fn(async () => ({ userId: '123', expiresAt: (now + 60 * DAY) / 1000 })),
    me: vi.fn(async () => ({ id: '123', username: 'demo_account' })),
    refresh: vi.fn(async () => ({ accessToken: SECOND, expiresIn: (60 * DAY) / 1000 })),
  };
  const options = { userData, encryption: crypto, client, now: clock };
  const manager = new ThreadsAccountManager(options);
  const input = (days = 60, userId = '123') => {
    vi.mocked(client.debugToken).mockResolvedValue({
      userId,
      expiresAt: (now + days * DAY) / 1000,
    });
    return { accessToken: FIRST };
  };
  return {
    userData,
    client,
    crypto,
    options,
    manager,
    input,
    clock,
    advance: (days: number) => {
      now += days * DAY;
    },
  };
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('Threads account storage and lifecycle', () => {
  it('persists only OS-encrypted account data outside the library and never returns tokens in views', async () => {
    const f = await fixture();
    const view = await f.manager.connect(f.input());
    expect(view.account).toMatchObject({
      id: '123',
      username: 'demo_account',
      expiresAt: new Date(f.clock() + 60 * DAY).toISOString(),
    });
    expect(JSON.stringify(view)).not.toContain(FIRST);
    const saved = await readFile(join(f.userData, 'threads-account.json'), 'utf8');
    expect(saved).not.toContain(FIRST);
    expect(saved).not.toContain('demo_account');
    expect(await readdir(f.userData)).toEqual(['threads-account.json']);
    if (process.platform !== 'win32')
      expect((await stat(join(f.userData, 'threads-account.json'))).mode & 0o777).toBe(0o600);
    expect(await new ThreadsAccountManager(f.options).status()).toEqual(view);
    expect((await f.manager.credentials()).accessToken).toBe(FIRST);
  });
  it('stores the exact server expiry of a token already issued ten days ago', async () => {
    const f = await fixture();
    const expiresAt = (f.clock() + 50 * DAY) / 1000 + 17;
    vi.mocked(f.client.debugToken).mockResolvedValueOnce({ userId: '123', expiresAt });
    const view = await f.manager.connect({ accessToken: FIRST });
    expect(view.problem).toBeNull();
    expect(view.account?.expiresAt).toBe(new Date(expiresAt * 1000).toISOString());
    expect(vi.mocked(f.client.debugToken)).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect((await new ThreadsAccountManager(f.options).status()).account?.expiresAt).toBe(
      view.account?.expiresAt,
    );
    expect(f.client.debugToken).toHaveBeenCalledTimes(1);
  });
  it.each(['debug', 'me'])('does not alter server expiry when %s responds late', async (phase) => {
    const f = await fixture();
    const expiresAt = (f.clock() + 50 * DAY) / 1000 + 17;
    const debugResponse = deferred<{ userId: string; expiresAt: number }>();
    const profileResponse = deferred<{ id: string; username: string }>();
    vi.mocked(f.client.debugToken).mockReturnValueOnce(
      phase === 'debug' ? debugResponse.promise : Promise.resolve({ userId: '123', expiresAt }),
    );
    if (phase === 'me') vi.mocked(f.client.me).mockReturnValueOnce(profileResponse.promise);
    const connecting = f.manager.connect({ accessToken: FIRST });
    await vi.waitFor(() =>
      expect(phase === 'debug' ? f.client.debugToken : f.client.me).toHaveBeenCalledTimes(1),
    );
    f.advance(0.5);
    debugResponse.resolve({ userId: '123', expiresAt });
    profileResponse.resolve({ id: '123', username: 'demo_account' });
    const view = await connecting;
    expect(view.account?.expiresAt).toBe(new Date(expiresAt * 1000).toISOString());
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, undefined, null, '1234567890'])(
    'refuses unusable debug expiry %s instead of estimating a new duration',
    async (expiresAt) => {
      const f = await fixture();
      vi.mocked(f.client.debugToken).mockResolvedValueOnce({
        userId: '123',
        expiresAt,
      } as unknown as { userId: string; expiresAt: number });
      expect((await f.manager.connect({ accessToken: FIRST })).problem?.code).toBe(
        'account_response',
      );
      expect(f.client.me).not.toHaveBeenCalled();
      expect(await readdir(f.userData)).toEqual([]);
    },
  );
  it.each([0, -1])('rejects a server expiry %i seconds from now', async (difference) => {
    const f = await fixture();
    vi.mocked(f.client.debugToken).mockResolvedValueOnce({
      userId: '123',
      expiresAt: f.clock() / 1000 + difference,
    });
    expect((await f.manager.connect({ accessToken: FIRST })).problem?.code).toBe('account_expired');
    expect(f.client.me).not.toHaveBeenCalled();
  });
  it('accepts only token input and rejects retired duration or date fields', async () => {
    const f = await fixture();
    for (const input of [
      { accessToken: FIRST, expiresIn: 5184000 },
      { accessToken: FIRST, expiresAt: '2026-11-27T00:00:00.000Z' },
      {},
    ])
      expect((await f.manager.connect(input)).problem?.code).toBe('account_input');
    expect(f.client.debugToken).not.toHaveBeenCalled();
    expect(f.client.me).not.toHaveBeenCalled();
  });
  it('reuses a valid stored expiry for the same token across status calls and restarts', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    vi.mocked(f.client.debugToken).mockClear();
    vi.mocked(f.client.me).mockClear();
    const manager = new ThreadsAccountManager(f.options);
    const before = await manager.status();
    await manager.status();
    await manager.credentials();
    await manager.connect({ accessToken: FIRST });
    expect(f.client.debugToken).not.toHaveBeenCalled();
    expect(f.client.me).not.toHaveBeenCalled();
    expect(await manager.status()).toEqual(before);
  });
  it('preserves the previous account and gives a safe tester-role hint when debug permission is missing', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    const before = await readFile(join(f.userData, 'threads-account.json'), 'utf8');
    vi.mocked(f.client.debugToken).mockRejectedValueOnce({
      code: 'permission_missing',
      message: SECOND,
    });
    const result = await f.manager.connect({ accessToken: SECOND });
    expect(result.problem?.code).toBe('account_debug_permission');
    expect(result.problem?.message).toContain('테스터');
    expect(result.problem?.message).toContain('초대를 수락');
    expect(JSON.stringify(result)).not.toContain(SECOND);
    expect((await f.manager.credentials()).accessToken).toBe(FIRST);
    expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(before);
  });
  it('rejects a debug/me account mismatch without replacing the previous token', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    const before = await readFile(join(f.userData, 'threads-account.json'), 'utf8');
    vi.mocked(f.client.debugToken).mockResolvedValueOnce({
      userId: '456',
      expiresAt: (f.clock() + 50 * DAY) / 1000,
    });
    expect((await f.manager.connect({ accessToken: SECOND })).problem?.code).toBe(
      'account_response',
    );
    expect((await f.manager.credentials()).accessToken).toBe(FIRST);
    expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(before);
  });
  it('fails closed when encryption is unavailable and does not make API requests', async () => {
    const f = await fixture();
    f.crypto.isAvailable = () => false;
    expect((await f.manager.connect(f.input())).problem?.code).toBe('account_unavailable');
    expect(f.client.me).not.toHaveBeenCalled();
    expect(await readdir(f.userData)).toEqual([]);
  });
  it.each(['not json', JSON.stringify({ version: 1, ciphertext: 'AAAA' })])(
    'preserves a corrupt store and blocks replacement: %s',
    async (bytes) => {
      const f = await fixture();
      await writeFile(join(f.userData, 'threads-account.json'), bytes);
      expect((await f.manager.status()).problem?.code).toBe('account_corrupt');
      expect((await f.manager.connect(f.input())).problem?.code).toBe('account_corrupt');
      await f.manager.disconnect();
      expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(bytes);
      expect(f.client.me).not.toHaveBeenCalled();
    },
  );
  it('rejects malformed decrypted state without returning injected private fields', async () => {
    const f = await fixture();
    const ciphertext = await f.crypto.encryptString(
      JSON.stringify({ version: 1, account: { accessToken: FIRST }, history: [], problem: null }),
    );
    await writeFile(
      join(f.userData, 'threads-account.json'),
      JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') }),
    );
    const view = await f.manager.status();
    expect(view.problem?.code).toBe('account_corrupt');
    expect(view.account).toBeNull();
    expect(JSON.stringify(view)).not.toContain(FIRST);
  });
  it('preserves the active account if identity validation or encrypted persistence fails', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    const before = await readFile(join(f.userData, 'threads-account.json'), 'utf8');
    vi.mocked(f.client.me).mockRejectedValueOnce(new Error('url?access_token=' + SECOND));
    const failed = await f.manager.connect({ ...f.input(), accessToken: SECOND });
    expect(failed.account?.id).toBe('123');
    expect(JSON.stringify(failed)).not.toContain(SECOND);
    f.crypto.encryptString = () => {
      throw new Error(FIRST);
    };
    expect((await f.manager.connect({ ...f.input(), accessToken: SECOND })).problem?.code).toBe(
      'account_storage',
    );
    expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(before);
    expect((await f.manager.credentials()).accessToken).toBe(FIRST);
  });
  it('preserves identity-specific history while replacing same or different accounts and disconnecting', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    await f.manager.connect({ ...f.input(), accessToken: SECOND });
    vi.mocked(f.client.me).mockResolvedValueOnce({ id: '456', username: 'second_account' });
    const switched = await f.manager.connect(f.input(60, '456'));
    expect(switched.account?.id).toBe('456');
    expect(switched.history.filter((entry) => entry.accountId === '123')).toHaveLength(4);
    const cleared = await f.manager.disconnect();
    expect(cleared.account).toBeNull();
    expect(cleared.history).toHaveLength(6);
    expect((await new ThreadsAccountManager(f.options).status()).history).toEqual(cleared.history);
    await expect(f.manager.credentials()).rejects.toMatchObject({ code: 'account_auth' });
  });
  it('refreshes only when due, persists the returned expiry and does not retry more than once per day', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    f.advance(29);
    await f.manager.refreshIfDue();
    expect(f.client.refresh).not.toHaveBeenCalled();
    f.advance(1);
    const renewed = await f.manager.refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect(renewed.account?.expiresAt).toBe(new Date(f.clock() + 60 * DAY).toISOString());
    expect(renewed.account?.lastRefreshedAt).toBe(new Date(f.clock()).toISOString());
    expect((await f.manager.credentials()).accessToken).toBe(SECOND);
    await new ThreadsAccountManager(f.options).refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
    expect(f.client.debugToken).toHaveBeenCalledTimes(1);
  });
  it('refreshes an existing token imported shortly before its actual expiry', async () => {
    const f = await fixture();
    await f.manager.connect(f.input(0.5));
    const result = await f.manager.refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledExactlyOnceWith(FIRST);
    expect(result.account?.expiresAt).toBe(new Date(f.clock() + 60 * DAY).toISOString());
  });
  it('does not refresh expired or revoked tokens', async () => {
    const f = await fixture();
    await f.manager.connect(f.input(2));
    vi.mocked(f.client.refresh).mockRejectedValue(new ThreadsAccountError('account_auth'));
    const failed = await f.manager.refreshIfDue();
    expect(failed.account?.requiresReconnect).toBe(true);
    f.advance(0.5);
    await f.manager.refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
    await expect(f.manager.credentials()).rejects.toMatchObject({ code: 'account_auth' });
    const another = await fixture();
    await another.manager.connect(another.input(1));
    another.advance(2);
    expect((await another.manager.refreshIfDue()).problem?.code).toBe('account_expired');
    expect(another.client.refresh).not.toHaveBeenCalled();
    await expect(another.manager.credentials()).rejects.toMatchObject({ code: 'account_expired' });
  });
  it.each([
    ['auth_expired', 'account_auth'],
    ['permission_missing', 'account_permission'],
    ['rate_limited', 'account_rate_limit'],
  ])('maps client %s errors to safe account state', async (apiCode, expected) => {
    const f = await fixture();
    await f.manager.connect(f.input());
    f.advance(31);
    vi.mocked(f.client.refresh).mockRejectedValue({
      code: apiCode,
      message: FIRST,
      maybeSent: false,
    });
    const result = await f.manager.refreshIfDue();
    expect(result.problem?.code).toBe(expected);
    expect(result.account?.requiresReconnect).toBe(apiCode !== 'rate_limited');
    expect(JSON.stringify(result)).not.toContain(FIRST);
  });
  it('deduplicates concurrent refreshes and preserves the previous token on transient failure', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    f.advance(35);
    const request = deferred<{ accessToken: string; expiresIn: number }>();
    vi.mocked(f.client.refresh).mockReturnValueOnce(request.promise);
    const a = f.manager.refreshIfDue();
    const b = f.manager.refreshIfDue();
    await vi.waitFor(() => expect(f.client.refresh).toHaveBeenCalledTimes(1));
    request.reject(new Error('private ' + FIRST));
    await Promise.all([a, b]);
    expect((await f.manager.credentials()).accessToken).toBe(FIRST);
    expect(JSON.stringify(await f.manager.status())).not.toContain(FIRST);
    await new ThreadsAccountManager(f.options).refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledTimes(1);
    f.advance(1);
    await f.manager.refreshIfDue();
    expect(f.client.refresh).toHaveBeenCalledTimes(2);
  });
  it('keeps an immediate disconnect authoritative while initial storage loading is pending', async () => {
    const f = await fixture();
    const connected = f.manager.connect(f.input());
    const disconnected = f.manager.disconnect();
    await Promise.all([connected, disconnected]);
    expect((await f.manager.status()).account).toBeNull();
    expect(f.client.me).not.toHaveBeenCalled();
  });
  it.each(['replace', 'disconnect'])(
    'does not allow a late refresh to undo %s',
    async (operation) => {
      const f = await fixture();
      await f.manager.connect(f.input());
      f.advance(35);
      const request = deferred<{ accessToken: string; expiresIn: number }>();
      vi.mocked(f.client.refresh).mockReturnValueOnce(request.promise);
      const refresh = f.manager.refreshIfDue();
      await vi.waitFor(() => expect(f.client.refresh).toHaveBeenCalledTimes(1));
      if (operation === 'replace') {
        vi.mocked(f.client.me).mockResolvedValueOnce({ id: '456', username: 'second_account' });
        await f.manager.connect({ ...f.input(60, '456'), accessToken: SECOND });
      } else await f.manager.disconnect();
      request.resolve({
        accessToken: 'STALE_REFRESH_TOKEN_1234567890',
        expiresIn: (60 * DAY) / 1000,
      });
      const done = await refresh;
      expect(done.account?.id ?? null).toBe(operation === 'replace' ? '456' : null);
      expect(done.history.at(-1)?.action).toBe(
        operation === 'replace' ? 'connected' : 'disconnected',
      );
      expect(done.busy).toBe(false);
      const restarted = new ThreadsAccountManager(f.options);
      expect((await restarted.status()).account?.id ?? null).toBe(
        operation === 'replace' ? '456' : null,
      );
      if (operation === 'replace') expect((await restarted.credentials()).accessToken).toBe(SECOND);
    },
  );
});

async function setLegacyExpiry(
  f: Awaited<ReturnType<typeof fixture>>,
  expiresAt: unknown,
): Promise<string> {
  const path = join(f.userData, 'threads-account.json');
  const envelope = JSON.parse(await readFile(path, 'utf8'));
  const saved = JSON.parse(
    await f.crypto.decryptString(Buffer.from(envelope.ciphertext, 'base64')),
  );
  if (expiresAt === undefined) delete saved.account.expiresAt;
  else saved.account.expiresAt = expiresAt;
  const ciphertext = await f.crypto.encryptString(JSON.stringify(saved));
  const bytes = JSON.stringify({ version: 1, ciphertext: ciphertext.toString('base64') });
  await writeFile(path, bytes);
  return bytes;
}

describe('legacy stored token expiry repair', () => {
  it.each([undefined, null])(
    'looks up %s expiry once, persists it, and reuses it after restart',
    async (missing) => {
      const f = await fixture();
      const original = await f.manager.connect(f.input());
      await setLegacyExpiry(f, missing);
      vi.mocked(f.client.debugToken).mockClear();
      vi.mocked(f.client.me).mockClear();
      const expiresAt = (f.clock() + 50 * DAY) / 1000 + 37;
      vi.mocked(f.client.debugToken).mockResolvedValue({ userId: '123', expiresAt });
      const manager = new ThreadsAccountManager(f.options);
      const [first, second] = await Promise.all([manager.status(), manager.status()]);
      expect(first).toEqual(second);
      expect(first.account?.expiresAt).toBe(new Date(expiresAt * 1000).toISOString());
      expect(first.history).toEqual(original.history);
      expect(f.client.debugToken).toHaveBeenCalledExactlyOnceWith(FIRST);
      await manager.credentials();
      await new ThreadsAccountManager(f.options).status();
      expect(f.client.debugToken).toHaveBeenCalledTimes(1);
      expect(f.client.me).not.toHaveBeenCalled();
    },
  );
  it('keeps legacy bytes on permission failure, stops repeated automatic checks, and accepts an explicit replacement', async () => {
    const f = await fixture();
    const original = await f.manager.connect(f.input());
    const before = await setLegacyExpiry(f, null);
    vi.mocked(f.client.debugToken).mockClear();
    vi.mocked(f.client.debugToken).mockRejectedValueOnce({
      code: 'permission_missing',
      message: FIRST,
    });
    const manager = new ThreadsAccountManager(f.options);
    expect(await manager.status()).toMatchObject({
      account: null,
      problem: { code: 'account_debug_permission' },
    });
    await manager.status();
    await expect(manager.credentials()).rejects.toMatchObject({ code: 'account_expiry' });
    expect(f.client.debugToken).toHaveBeenCalledTimes(1);
    expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(before);
    const replaced = await manager.connect({ accessToken: SECOND });
    expect(replaced.problem).toBeNull();
    expect(replaced.account?.id).toBe('123');
    expect(replaced.history.slice(0, original.history.length)).toEqual(original.history);
    expect(replaced.history.slice(-2).map((entry) => entry.action)).toEqual([
      'replaced',
      'connected',
    ]);
    expect((await manager.credentials()).accessToken).toBe(SECOND);
    expect(f.client.debugToken).toHaveBeenCalledTimes(2);
  });
  it('can explicitly retry the same legacy token after its debug access is fixed', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    await setLegacyExpiry(f, undefined);
    vi.mocked(f.client.debugToken).mockRejectedValueOnce(new Error('synthetic network failure'));
    const manager = new ThreadsAccountManager(f.options);
    expect((await manager.status()).problem?.code).toBe('account_expiry');
    expect((await manager.connect({ accessToken: FIRST })).problem).toBeNull();
    expect((await manager.credentials()).accessToken).toBe(FIRST);
  });
  it('does not treat an invalid expiry string as repairable missing metadata', async () => {
    const f = await fixture();
    await f.manager.connect(f.input());
    const before = await setLegacyExpiry(f, 'not-a-date');
    vi.mocked(f.client.debugToken).mockClear();
    const manager = new ThreadsAccountManager(f.options);
    expect((await manager.status()).problem?.code).toBe('account_corrupt');
    expect((await manager.connect({ accessToken: SECOND })).problem?.code).toBe('account_corrupt');
    expect(f.client.debugToken).not.toHaveBeenCalled();
    expect(await readFile(join(f.userData, 'threads-account.json'), 'utf8')).toBe(before);
  });
  it('can disconnect a valid legacy token after expiry lookup fails while preserving its history', async () => {
    const f = await fixture();
    const original = await f.manager.connect(f.input());
    await setLegacyExpiry(f, null);
    vi.mocked(f.client.debugToken).mockRejectedValueOnce(new Error('synthetic failure'));
    const manager = new ThreadsAccountManager(f.options);
    await manager.status();
    const removed = await manager.disconnect();
    expect(removed.account).toBeNull();
    expect(removed.problem).toBeNull();
    expect(removed.history.slice(0, original.history.length)).toEqual(original.history);
    expect(removed.history.at(-1)?.action).toBe('disconnected');
  });
});

describe('shared encrypted store', () => {
  it('does not initialize OS encryption for an empty installation', async () => {
    const f = await fixture();
    const available = vi.fn(async () => false);
    f.crypto.isAvailable = available;
    const view = await f.manager.status();
    expect(view.account).toBeNull();
    expect(view.problem).toBeNull();
    expect(available).not.toHaveBeenCalled();
    expect((await f.manager.connect(f.input())).problem?.code).toBe('account_unavailable');
    expect(f.client.me).not.toHaveBeenCalled();
    expect(available).toHaveBeenCalledTimes(1);
  });

  it('refuses to overwrite an unread corrupt file on the first write', async () => {
    const f = await fixture();
    await writeFile(join(f.userData, 'threads-history.json'), 'corrupt-original');
    const store = new EncryptedLocalStore({
      userData: f.userData,
      fileName: 'threads-history.json',
      encryption: f.crypto,
      validate: (value): value is string[] =>
        Array.isArray(value) && value.every((part) => typeof part === 'string'),
    });
    await expect(store.write(['new'])).rejects.toMatchObject({ code: 'corrupt' });
    expect(await readFile(join(f.userData, 'threads-history.json'), 'utf8')).toBe(
      'corrupt-original',
    );
  });

  it('supports asynchronous encryption and preserves bytes after an encryption error', async () => {
    const f = await fixture();
    const crypto = encryption();
    const store = new EncryptedLocalStore({
      userData: f.userData,
      fileName: 'threads-history.json',
      encryption: {
        isAvailable: async () => true,
        encryptString: async (value) => crypto.encryptString(value),
        decryptString: async (value) => crypto.decryptString(value),
      },
      validate: (value): value is { number: number } =>
        !!value &&
        typeof value === 'object' &&
        'number' in value &&
        typeof value.number === 'number',
    });
    expect(await store.read()).toBeNull();
    await store.write({ number: 3 });
    expect(await store.read()).toEqual({ number: 3 });
    const before = await readFile(join(f.userData, 'threads-history.json'), 'utf8');
    crypto.encryptString = () => {
      throw new Error('private');
    };
    await expect(store.write({ number: 4 })).rejects.toBeInstanceOf(SecretStoreError);
    expect(await readFile(join(f.userData, 'threads-history.json'), 'utf8')).toBe(before);
    expect(await readdir(f.userData)).toEqual(['threads-history.json']);
  });
});
