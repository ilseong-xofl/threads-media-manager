import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { request } from 'node:https';
import { isAbsolute } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { FileServerConnectionView } from '../shared/threads-api';
import type { ThreadsUploadFile } from './threads-media';
import {
  EncryptedLocalStore,
  SecretStoreError,
  type ThreadsAccountEncryption,
} from './threads-secret-store';

const FILE_SERVER = 'https://tfs.ilscp.net';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CODE_LENGTH = 2048;
const MAX_RESPONSE_BYTES = 16 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^tfs_u_[A-Za-z0-9_-]{43}$/;
const MEDIA_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
};
const MESSAGES = {
  file_server_input: '관리자에게 받은 파일 서버 연결 코드를 확인해 주세요.',
  file_server_missing: '설정에서 파일 서버 연결 코드를 먼저 저장해 주세요.',
  file_server_unavailable: '이 기기의 보안 저장소를 사용할 수 없습니다.',
  file_server_corrupt: '파일 서버 연결 정보를 읽지 못했습니다. 기존 정보를 보존했습니다.',
  file_server_local: '파일 서버 연결 정보를 안전하게 저장하지 못했습니다.',
  file_server_file: '전송할 미디어 파일의 형식과 크기를 확인해 주세요.',
  file_server_upload: '파일 서버에 미디어를 전송하지 못했습니다.',
  file_server_response: '파일 서버의 미디어 주소를 확인하지 못했습니다.',
  file_server_timeout: '미디어 전송 응답을 기다리는 시간이 초과되었습니다.',
  file_server_auth: '파일 서버 연결 코드를 사용할 수 없습니다. 관리자에게 다시 발급받아 주세요.',
  file_server_capacity: '파일 서버의 저장 공간이 부족합니다. 잠시 후 다시 시도해 주세요.',
  file_server_busy: '파일 서버가 혼잡합니다. 잠시 후 다시 시도해 주세요.',
} as const;
export class FileServerError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
    this.name = 'FileServerError';
  }
}
export interface FileServerUploadResponse {
  id: string;
  url: string;
  expiresAt: string;
  bytes: number;
  contentType: string;
}
export interface FileServerStorageAdapter {
  upload(
    server: string,
    token: string,
    input: { body: Readable; size: number; contentType: string; filename: string },
    signal: AbortSignal,
  ): Promise<FileServerUploadResponse>;
}
interface SavedConnection {
  server: string;
  token: string;
  savedAt: string;
}
interface StoredState {
  version: 1;
  connection: SavedConnection | null;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: string) =>
  Object.keys(value).sort().join(',') === keys;
function validTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== 24) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}
function validState(value: unknown): value is StoredState {
  return (
    object(value) &&
    exactKeys(value, 'connection,version') &&
    value.version === 1 &&
    (value.connection === null ||
      (object(value.connection) &&
        exactKeys(value.connection, 'savedAt,server,token') &&
        value.connection.server === FILE_SERVER &&
        typeof value.connection.token === 'string' &&
        TOKEN.test(value.connection.token) &&
        validTimestamp(value.connection.savedAt)))
  );
}
function decodeConnection(input: unknown): { server: string; token: string } {
  try {
    if (
      !object(input) ||
      !exactKeys(input, 'connectionCode') ||
      typeof input.connectionCode !== 'string' ||
      input.connectionCode.length > MAX_CODE_LENGTH
    )
      throw new Error();
    const match = /^tfs1\.([A-Za-z0-9_-]+)$/.exec(input.connectionCode.trim());
    if (!match) throw new Error();
    const bytes = Buffer.from(match[1], 'base64url');
    if (bytes.toString('base64url') !== match[1]) throw new Error();
    const data: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (
      !object(data) ||
      !exactKeys(data, 'server,token,v') ||
      data.v !== 1 ||
      data.server !== FILE_SERVER ||
      typeof data.token !== 'string' ||
      !TOKEN.test(data.token)
    )
      throw new Error();
    return { server: FILE_SERVER, token: data.token };
  } catch {
    throw new FileServerError('file_server_input');
  }
}
function httpError(status: number | undefined): FileServerError {
  return new FileServerError(
    status === 401 || status === 403
      ? 'file_server_auth'
      : status === 413 || status === 415
        ? 'file_server_file'
        : status === 507
          ? 'file_server_capacity'
          : status === 429
            ? 'file_server_busy'
            : 'file_server_upload',
  );
}
/** Native HTTPS never follows redirects. Both multipart media and response size are bounded. */
const httpsAdapter: FileServerStorageAdapter = {
  async upload(server, token, input, signal) {
    const boundary = `tmm-${randomUUID()}`;
    const prefix = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\nContent-Type: ${input.contentType}\r\n\r\n`,
    );
    const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    const multipart = Readable.from(
      (async function* () {
        yield prefix;
        let bytes = 0;
        for await (const chunk of input.body) {
          const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += data.length;
          if (bytes > input.size) throw new FileServerError('file_server_file');
          yield data;
        }
        if (bytes !== input.size) throw new FileServerError('file_server_file');
        yield suffix;
      })(),
    );
    const req = request(new URL('/api/uploads', server), {
      method: 'POST',
      agent: false,
      signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': prefix.length + input.size + suffix.length,
      },
    });
    const response = new Promise<unknown>((resolve, reject) => {
      req.once('error', reject);
      req.once('response', (res) => {
        void (async () => {
          try {
            if (res.statusCode !== 201) throw httpError(res.statusCode);
            if (!/^application\/json(?:\s*;|$)/i.test(res.headers['content-type'] ?? ''))
              throw new FileServerError('file_server_response');
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of res) {
              const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              bytes += data.length;
              if (bytes > MAX_RESPONSE_BYTES) throw new FileServerError('file_server_response');
              chunks.push(data);
            }
            try {
              return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
            } catch {
              throw new FileServerError('file_server_response');
            }
          } finally {
            res.destroy();
          }
        })().then(resolve, reject);
      });
    });
    try {
      const [result] = await Promise.all([response, pipeline(multipart, req, { signal })]);
      // Runtime response checks are shared with injected adapters in FileServerStorage.upload.
      return result as FileServerUploadResponse;
    } finally {
      multipart.destroy();
      req.destroy();
      input.body.destroy();
    }
  },
};

/** Connection codes and upload URLs stay in main; the renderer only receives the saved status. */
export class FileServerStorage {
  private readonly store: EncryptedLocalStore<StoredState>;
  private readonly adapter: FileServerStorageAdapter;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private operations: Promise<unknown> = Promise.resolve();
  constructor(options: {
    userData: string;
    encryption: ThreadsAccountEncryption;
    adapter?: FileServerStorageAdapter;
    now?: () => number;
    timeoutMs?: number;
  }) {
    this.store = new EncryptedLocalStore({
      userData: options.userData,
      fileName: 'file-server.json',
      encryption: options.encryption,
      validate: validState,
    });
    this.adapter = options.adapter ?? httpsAdapter;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1)
      throw new FileServerError('file_server_input');
  }
  private async safe<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof FileServerError) throw error;
      if (error instanceof SecretStoreError)
        throw new FileServerError(
          error.code === 'unavailable'
            ? 'file_server_unavailable'
            : error.code === 'corrupt'
              ? 'file_server_corrupt'
              : 'file_server_local',
        );
      throw new FileServerError('file_server_local');
    }
  }
  private run<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(() => this.safe(action));
    this.operations = pending.catch(() => {});
    return pending;
  }
  private async read(): Promise<StoredState> {
    return (await this.store.read()) ?? { version: 1, connection: null };
  }
  status(): Promise<FileServerConnectionView | null> {
    // Atomic reads remain available while a media upload is running.
    return this.safe(async () => {
      const connection = (await this.read()).connection;
      return connection ? { server: connection.server, savedAt: connection.savedAt } : null;
    });
  }
  connect(input: unknown): Promise<FileServerConnectionView> {
    return this.run(async () => {
      const { server, token } = decodeConnection(input);
      const savedAt = new Date(this.now()).toISOString();
      // Saving checks the local format and OS encryption, not remote token validity.
      await this.store.write({ version: 1, connection: { server, token, savedAt } });
      return { server, savedAt };
    });
  }
  disconnect(): Promise<void> {
    return this.run(() => this.store.write({ version: 1, connection: null }));
  }
  pendingKeys(): Promise<string[]> {
    // The file server owns expiry and physical cleanup, including uploads with lost responses.
    return Promise.resolve([]);
  }
  delete(keys: string[]): Promise<void> {
    void keys;
    // There is no remote delete API. Existing publishing cleanup may safely call this adapter.
    return this.run(async () => {});
  }
  private async timed<T>(action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new FileServerError('file_server_timeout'));
        controller.abort();
      }, this.timeoutMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => action(controller.signal)), timeout]);
    } catch (error) {
      if (error instanceof FileServerError) throw error;
      throw new FileServerError('file_server_upload');
    } finally {
      clearTimeout(timer);
    }
  }
  upload(
    operationId: string,
    ordinal: number,
    file: ThreadsUploadFile,
  ): Promise<{ key: string; url: string }> {
    return this.run(async () => {
      const extension =
        typeof file?.extension === 'string' ? file.extension.replace(/^\./, '') : '';
      if (
        !UUID.test(operationId) ||
        !Number.isInteger(ordinal) ||
        ordinal < 0 ||
        ordinal > 20 ||
        !Object.hasOwn(MEDIA_TYPES, extension) ||
        MEDIA_TYPES[extension] !== file.contentType ||
        typeof file.path !== 'string' ||
        !isAbsolute(file.path) ||
        !Number.isSafeInteger(file.size) ||
        file.size < 1 ||
        file.size > (file.contentType.startsWith('image/') ? 8 * 1024 * 1024 : 1024 ** 3)
      )
        throw new FileServerError('file_server_file');
      const connection = (await this.read()).connection;
      if (!connection) throw new FileServerError('file_server_missing');
      let handle;
      try {
        handle = await open(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== file.size) throw new Error();
      } catch {
        await handle?.close().catch(() => {});
        throw new FileServerError('file_server_file');
      }
      try {
        // Bound reads to the inspected size; multipart also rejects a file truncated during transfer.
        const body = handle.createReadStream({ autoClose: false, start: 0, end: file.size - 1 });
        try {
          const response: unknown = await this.timed((signal) =>
            this.adapter.upload(
              connection.server,
              connection.token,
              {
                body,
                size: file.size,
                contentType: file.contentType,
                filename: `${randomUUID()}.${extension}`,
              },
              signal,
            ),
          );
          const serverExtension = extension === 'jpeg' ? 'jpg' : extension;
          if (
            !object(response) ||
            !exactKeys(response, 'bytes,contentType,expiresAt,id,url') ||
            typeof response.id !== 'string' ||
            !UUID.test(response.id) ||
            response.url !==
              `${FILE_SERVER}/files/${response.id}/${response.id}.${serverExtension}` ||
            response.bytes !== file.size ||
            response.contentType !== file.contentType ||
            !validTimestamp(response.expiresAt) ||
            Date.parse(response.expiresAt) <= this.now()
          )
            throw new FileServerError('file_server_response');
          return { key: response.id, url: response.url as string };
        } finally {
          body.destroy();
        }
      } finally {
        await handle.close().catch(() => {});
      }
    });
  }
}
