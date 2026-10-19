import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface TokenCipher {
  decryptString(value: Buffer): Promise<string>;
  encryptString(value: string): Promise<Buffer>;
  isEncryptionAvailable(): Promise<boolean>;
}

export interface AuthTokenStore {
  clear(): Promise<void>;
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
}

export class AuthTokenStorageUnavailableError extends Error {
  constructor() {
    super('운영체제 보안 저장소를 사용할 수 없습니다.');
    this.name = 'AuthTokenStorageUnavailableError';
  }
}

export class EncryptedAuthTokenStore implements AuthTokenStore {
  constructor(
    private readonly filePath: string,
    private readonly cipher: TokenCipher,
  ) {}

  private async assertAvailable(): Promise<void> {
    if (!(await this.cipher.isEncryptionAvailable())) {
      throw new AuthTokenStorageUnavailableError();
    }
  }

  async read(): Promise<string | null> {
    await this.assertAvailable();

    try {
      const encrypted = await readFile(this.filePath);
      const token = (await this.cipher.decryptString(encrypted)).trim();
      if (!token) {
        await this.clear();
        return null;
      }
      return token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      await this.clear();
      return null;
    }
  }

  async write(token: string): Promise<void> {
    await this.assertAvailable();
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new Error('빈 인증 토큰은 저장할 수 없습니다.');
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, await this.cipher.encryptString(normalizedToken), {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
