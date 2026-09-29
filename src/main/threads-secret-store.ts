import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
export interface ThreadsAccountEncryption {
  isAvailable(): boolean | Promise<boolean>;
  encryptString(value: string): Buffer | Promise<Buffer>;
  decryptString(value: Buffer): string | Promise<string>;
}
export class SecretStoreError extends Error {
  constructor(readonly code: 'unavailable' | 'corrupt' | 'storage') {
    super('Secure local storage could not complete the operation.');
  }
}
export interface EncryptedLocalStoreOptions<T> {
  userData: string;
  fileName: string;
  encryption: ThreadsAccountEncryption;
  validate: (value: unknown) => value is T;
}
/** App-owned data only. Credentials never enter the library backup or a plaintext file. */
export class EncryptedLocalStore<T> {
  private readonly path: string;
  private unreadable = false;
  private checked = false;
  constructor(private readonly options: EncryptedLocalStoreOptions<T>) {
    if (!/^[a-z][a-z0-9-]*\.json$/.test(options.fileName)) throw new SecretStoreError('storage');
    this.path = join(options.userData, options.fileName);
  }
  async read(): Promise<T | null> {
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error();
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        this.checked = true;
        return null;
      }
      this.unreadable = true;
      throw new SecretStoreError('corrupt');
    }
    // A fresh installation must not initialize Keychain just to display empty settings.
    if (!(await this.options.encryption.isAvailable())) throw new SecretStoreError('unavailable');
    try {
      const envelope = JSON.parse(await readFile(this.path, 'utf8'));
      if (
        !envelope ||
        envelope.version !== 1 ||
        typeof envelope.ciphertext !== 'string' ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
          envelope.ciphertext,
        ) ||
        !envelope.ciphertext.length
      )
        throw new Error();
      const value: unknown = JSON.parse(
        await this.options.encryption.decryptString(Buffer.from(envelope.ciphertext, 'base64')),
      );
      if (!this.options.validate(value)) throw new Error();
      this.checked = true;
      return value;
    } catch {
      this.unreadable = true;
      throw new SecretStoreError('corrupt');
    }
  }
  async write(value: T): Promise<void> {
    if (this.unreadable) throw new SecretStoreError('corrupt');
    if (!this.checked) await this.read();
    if (!(await this.options.encryption.isAvailable())) throw new SecretStoreError('unavailable');
    if (!this.options.validate(value)) throw new SecretStoreError('storage');
    const temporary = this.path + '.' + randomUUID() + '.tmp';
    try {
      const ciphertext = (
        await this.options.encryption.encryptString(JSON.stringify(value))
      ).toString('base64');
      if (!ciphertext) throw new Error();
      const envelope = JSON.stringify({ version: 1, ciphertext }) + '\n';
      if (Buffer.byteLength(envelope) > MAX_FILE_BYTES) throw new Error();
      await mkdir(this.options.userData, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(envelope, 'utf8');
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
    } catch {
      await unlink(temporary).catch(() => {});
      throw new SecretStoreError('storage');
    }
  }
}
