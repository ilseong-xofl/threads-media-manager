import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  AuthTokenStorageUnavailableError,
  EncryptedAuthTokenStore,
  type TokenCipher,
} from './auth-token-store';

class TestCipher implements TokenCipher {
  constructor(private readonly available = true) {}

  async decryptString(value: Buffer): Promise<string> {
    return Buffer.from(value.toString('utf8'), 'base64').toString('utf8');
  }

  async encryptString(value: string): Promise<Buffer> {
    return Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8');
  }

  async isEncryptionAvailable(): Promise<boolean> {
    return this.available;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function createStore(cipher = new TestCipher()) {
  const directory = await mkdtemp(join(tmpdir(), 'tmm-auth-token-test-'));
  temporaryDirectories.push(directory);
  const filePath = join(directory, 'auth', 'session.bin');
  return { filePath, store: new EncryptedAuthTokenStore(filePath, cipher) };
}

describe('EncryptedAuthTokenStore', () => {
  it('stores an encrypted token and restores it', async () => {
    const { filePath, store } = await createStore();

    await store.write('signed-token');

    expect((await readFile(filePath, 'utf8')).includes('signed-token')).toBe(false);
    await expect(store.read()).resolves.toBe('signed-token');
  });

  it('clears the stored token', async () => {
    const { store } = await createStore();
    await store.write('signed-token');

    await store.clear();

    await expect(store.read()).resolves.toBeNull();
  });

  it('fails closed when OS encryption is unavailable', async () => {
    const { store } = await createStore(new TestCipher(false));

    await expect(store.read()).rejects.toBeInstanceOf(AuthTokenStorageUnavailableError);
    await expect(store.write('signed-token')).rejects.toBeInstanceOf(
      AuthTokenStorageUnavailableError,
    );
  });
});
