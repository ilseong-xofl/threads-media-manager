import { mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileServerError,
  FileServerStorage,
  type FileServerStorageAdapter,
  type FileServerUploadResponse,
} from './file-server-storage';
import type { ThreadsAccountEncryption } from './threads-secret-store';
import type { ThreadsUploadFile } from './threads-media';

const network = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('node:https', () => ({ request: network.request }));
const SERVER = 'https://tfs.ilscp.net';
const TOKEN = `tfs_u_${'a'.repeat(43)}`;
const NOW = Date.parse('2026-09-28T12:00:00.000Z');
const OPERATION = '12345678-1234-4123-8123-123456789abc';
const UPLOAD = '87654321-1234-4123-8123-123456789abc';
const encode = (value: unknown) =>
  `tfs1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
const CODE = encode({ v: 1, server: SERVER, token: TOKEN });
const directories: string[] = [];
// This reversible test double is never used by the application; main passes OS safeStorage.
const encryption: ThreadsAccountEncryption = {
  isAvailable: () => true,
  encryptString: (text) => Buffer.from([...Buffer.from(text)].map((byte) => byte ^ 0xa5)),
  decryptString: (data) => Buffer.from([...data].map((byte) => byte ^ 0xa5)).toString('utf8'),
};
function reply(overrides: Partial<FileServerUploadResponse> = {}): FileServerUploadResponse {
  return {
    id: UPLOAD,
    url: `${SERVER}/files/${UPLOAD}/${UPLOAD}.jpg`,
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    bytes: 14,
    contentType: 'image/jpeg',
    ...overrides,
  };
}
async function setup(
  options: {
    adapter?: FileServerStorageAdapter;
    timeoutMs?: number;
    encryption?: ThreadsAccountEncryption;
  } = {},
) {
  const userData = await mkdtemp(join(tmpdir(), 'tmm-file-server-test-'));
  directories.push(userData);
  const path = join(userData, 'private-original-name.jpg');
  await writeFile(path, 'synthetic-file');
  const storage = new FileServerStorage({ userData, encryption, now: () => NOW, ...options });
  const file: ThreadsUploadFile = {
    path,
    size: 14,
    contentType: 'image/jpeg',
    extension: 'jpg',
    kind: 'image',
    mediaId: 'synthetic-media',
    sha256: 'a'.repeat(64),
  };
  return { storage, userData, file };
}
async function connected(options: Parameters<typeof setup>[0] = {}) {
  const fixture = await setup(options);
  await fixture.storage.connect({ connectionCode: CODE });
  return fixture;
}
function adapter() {
  return {
    upload: vi.fn(async (_server, _token, input) => {
      for await (const chunk of input.body) void chunk;
      return reply();
    }) as ReturnType<typeof vi.fn<FileServerStorageAdapter['upload']>>,
  };
}
async function failure(promise: Promise<unknown>, code: FileServerError['code']) {
  await expect(promise).rejects.toMatchObject({ name: 'FileServerError', code });
}
interface HttpMock {
  chunks: Buffer[];
  request?: Writable;
}
function mockHttp(
  options: { status?: number; contentType?: string; body?: string } = {},
): HttpMock {
  const captured: HttpMock = { chunks: [] };
  network.request.mockImplementation(() => {
    const req = new Writable({
      write(chunk, _encoding, done) {
        captured.chunks.push(Buffer.from(chunk));
        done();
      },
      final(done) {
        done();
        queueMicrotask(() => {
          const response = Object.assign(new PassThrough(), {
            statusCode: options.status ?? 201,
            headers: { 'content-type': options.contentType ?? 'application/json; charset=utf-8' },
          });
          req.emit('response', response);
          response.end(options.body ?? JSON.stringify(reply()));
        });
      },
    });
    captured.request = req;
    return req;
  });
  return captured;
}
beforeEach(() => {
  vi.clearAllMocks();
  network.request.mockImplementation(() => {
    throw new Error('Unexpected network operation');
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe('encrypted file-server connection', () => {
  it('shows an empty status without touching encryption or the network', async () => {
    const unavailable = { ...encryption, isAvailable: vi.fn(() => false) };
    const { storage, userData } = await setup({ encryption: unavailable });
    expect(await storage.status()).toBeNull();
    expect(unavailable.isAvailable).not.toHaveBeenCalled();
    await expect(readFile(join(userData, 'file-server.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(network.request).not.toHaveBeenCalled();
  });

  it('saves the code only in OS-encrypted storage and returns a secret-free view after restart', async () => {
    const { storage, userData } = await setup();
    const view = { server: SERVER, savedAt: new Date(NOW).toISOString() };
    expect(await storage.connect({ connectionCode: ` \n${CODE}\n ` })).toEqual(view);
    const saved = await readFile(join(userData, 'file-server.json'), 'utf8');
    expect(saved).not.toContain(TOKEN);
    expect(saved).not.toContain(CODE);
    expect(saved).not.toContain(SERVER);
    expect(JSON.parse(saved)).toMatchObject({ version: 1, ciphertext: expect.any(String) });
    const restored = new FileServerStorage({ userData, encryption, now: () => NOW });
    expect(await restored.status()).toEqual(view);
    expect(network.request).not.toHaveBeenCalled();
  });

  it.each([
    null,
    CODE,
    {},
    { connectionCode: CODE, token: TOKEN },
    { connectionCode: TOKEN },
    { connectionCode: CODE + '=' },
    { connectionCode: 'tfs1.' + 'a'.repeat(2048) },
    { connectionCode: encode({ v: 2, server: SERVER, token: TOKEN }) },
    { connectionCode: encode({ v: 1, server: SERVER, token: TOKEN, extra: true }) },
    { connectionCode: encode({ v: 1, server: SERVER, token: 'invalid' }) },
    ...[
      'http://tfs.ilscp.net',
      'http://127.0.0.1:3005',
      'https://attacker.test',
      SERVER + '/',
      SERVER + ':443',
      SERVER + '/api',
      SERVER + '?x=1',
      'https://user:password@tfs.ilscp.net',
    ].map((server) => ({ connectionCode: encode({ v: 1, server, token: TOKEN }) })),
  ])('rejects malformed or non-official connection code %# without a request', async (input) => {
    const { storage } = await setup();
    await failure(storage.connect(input), 'file_server_input');
    expect(await storage.status()).toBeNull();
    expect(network.request).not.toHaveBeenCalled();
  });

  it('does not save when OS encryption is unavailable', async () => {
    const { storage, userData } = await setup({
      encryption: { ...encryption, isAvailable: () => false },
    });
    await failure(storage.connect({ connectionCode: CODE }), 'file_server_unavailable');
    await expect(readFile(join(userData, 'file-server.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('preserves unreadable saved connection data instead of overwriting it', async () => {
    const { storage, userData } = await setup();
    const path = join(userData, 'file-server.json');
    await writeFile(path, 'corrupt fixture');
    await failure(storage.status(), 'file_server_corrupt');
    await failure(storage.connect({ connectionCode: CODE }), 'file_server_corrupt');
    await failure(storage.disconnect(), 'file_server_corrupt');
    expect(await readFile(path, 'utf8')).toBe('corrupt fixture');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('serializes disconnect after active upload, and leaves cleanup to server expiry', async () => {
    let started!: () => void;
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const complete = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const upload = vi.fn<FileServerStorageAdapter['upload']>(async (_server, _token, input) => {
      for await (const chunk of input.body) void chunk;
      started();
      await complete;
      return reply();
    });
    const { storage } = await connected({ adapter: { upload } });
    const fixture = await setup();
    const active = storage.upload(OPERATION, 1, fixture.file);
    await ready;
    let disconnected = false;
    const disconnect = storage.disconnect().then(() => {
      disconnected = true;
    });
    expect(await storage.status()).not.toBeNull();
    expect(disconnected).toBe(false);
    expect(await storage.pendingKeys()).toEqual([]);
    finish();
    await active;
    await disconnect;
    expect(await storage.status()).toBeNull();
    await storage.delete([UPLOAD]);
    expect(await storage.pendingKeys()).toEqual([]);
    expect(upload).toHaveBeenCalledOnce();
    expect(network.request).not.toHaveBeenCalled();
  });
});

describe('bounded authenticated uploads', () => {
  it('requires a saved connection before upload', async () => {
    const mock = adapter();
    const { storage, file } = await setup({ adapter: mock });
    await failure(storage.upload(OPERATION, 1, file), 'file_server_missing');
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it('streams the file and supplies only a random safe filename and saved credentials', async () => {
    const mock = adapter();
    const { storage, file } = await connected({ adapter: mock });
    expect(await storage.upload(OPERATION, 1, file)).toEqual({ key: UPLOAD, url: reply().url });
    expect(mock.upload).toHaveBeenCalledOnce();
    const [server, token, input, signal] = mock.upload.mock.calls[0];
    expect(server).toBe(SERVER);
    expect(token).toBe(TOKEN);
    expect(input.body).toBeInstanceOf(Readable);
    expect(input.size).toBe(14);
    expect(input.contentType).toBe('image/jpeg');
    expect(input.filename).toMatch(/^[0-9a-f-]{36}\.jpg$/);
    expect(input.filename).not.toContain('private-original');
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(await storage.pendingKeys()).toEqual([]);
  });

  it('opens a 1 GiB video as a bounded stream without loading it into memory', async () => {
    const mock = adapter();
    mock.upload.mockImplementationOnce(async (_server, _token, input) => {
      expect(input.body.readableHighWaterMark).toBeLessThanOrEqual(64 * 1024);
      const chunk: Buffer = await new Promise((resolve, reject) => {
        input.body.once('data', (data) => {
          input.body.pause();
          resolve(data);
        });
        input.body.once('error', reject);
      });
      expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
      return reply({
        bytes: 1024 ** 3,
        contentType: 'video/mp4',
        url: `${SERVER}/files/${UPLOAD}/${UPLOAD}.mp4`,
      });
    });
    const { storage, file } = await connected({ adapter: mock });
    const handle = await open(file.path, 'w');
    await handle.truncate(1024 ** 3);
    await handle.close();
    const video = {
      ...file,
      size: 1024 ** 3,
      contentType: 'video/mp4',
      extension: 'mp4',
      kind: 'video' as const,
    };
    expect((await storage.upload(OPERATION, 1, video)).key).toBe(UPLOAD);
  });

  it('normalizes JPEG response extensions to the server-generated jpg filename', async () => {
    const { storage, file } = await connected({ adapter: adapter() });
    expect((await storage.upload(OPERATION, 1, { ...file, extension: '.jpeg' })).url).toBe(
      reply().url,
    );
  });

  it.each([
    { extension: 'gif' },
    { contentType: 'text/html' },
    { extension: 'jpg\r\nX-Evil: true' },
    { size: 0 },
    { size: 15 },
    { size: 8 * 1024 * 1024 + 1 },
    { path: 'relative.jpg' },
  ])('rejects unsupported or mismatched local file %# before uploading', async (change) => {
    const mock = adapter();
    const { storage, file } = await connected({ adapter: mock });
    await failure(storage.upload(OPERATION, 1, { ...file, ...change }), 'file_server_file');
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it('rejects symbolic links and directories', async () => {
    const mock = adapter();
    const { storage, file, userData } = await connected({ adapter: mock });
    const link = join(userData, 'linked.jpg');
    await symlink(file.path, link);
    await failure(storage.upload(OPERATION, 1, { ...file, path: link }), 'file_server_file');
    await failure(storage.upload(OPERATION, 1, { ...file, path: userData }), 'file_server_file');
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it.each([
    { url: 'https://attacker.test/file.jpg' },
    { url: `${SERVER}/files/${UPLOAD}/${UPLOAD}.jpg?token=secret` },
    { url: `${SERVER}/files/${UPLOAD}/${UPLOAD}.jpg#part` },
    { url: `${SERVER}/files/${UPLOAD}/other.jpg` },
    { url: `${SERVER}/files/${UPLOAD}/../${UPLOAD}.jpg` },
    { id: OPERATION },
    { bytes: 15 },
    { contentType: 'video/mp4' },
    { expiresAt: new Date(NOW).toISOString() },
    { expiresAt: 'invalid' },
  ])('rejects unexpected upload response %# before returning an address', async (change) => {
    const mock = adapter();
    mock.upload.mockResolvedValue(reply(change));
    const { storage, file } = await connected({ adapter: mock });
    await failure(storage.upload(OPERATION, 1, file), 'file_server_response');
    expect(mock.upload).toHaveBeenCalledOnce();
  });

  it('aborts a timed-out request without retry and remains usable afterward', async () => {
    let signal!: AbortSignal;
    const mock = adapter();
    mock.upload.mockImplementationOnce(async (_server, _token, _input, receivedSignal) => {
      signal = receivedSignal;
      return await new Promise(() => {});
    });
    const { storage, file } = await connected({ adapter: mock, timeoutMs: 20 });
    await failure(storage.upload(OPERATION, 1, file), 'file_server_timeout');
    expect(signal.aborted).toBe(true);
    expect(mock.upload).toHaveBeenCalledOnce();
    expect(await storage.status()).not.toBeNull();
    await storage.disconnect();
    expect(await storage.status()).toBeNull();
  });

  it('does not expose tokens or raw response errors', async () => {
    const mock = adapter();
    mock.upload.mockRejectedValue(
      new Error(`Authorization Bearer ${TOKEN} private error response`),
    );
    const { storage, file } = await connected({ adapter: mock });
    try {
      await storage.upload(OPERATION, 1, file);
      expect.fail('Expected upload failure');
    } catch (error) {
      expect(error).toBeInstanceOf(FileServerError);
      expect(error).toMatchObject({ code: 'file_server_upload' });
      expect(String(error)).not.toContain(TOKEN);
      expect(String(error)).not.toContain('private error response');
      expect((error as Error).cause).toBeUndefined();
    }
  });
});

describe('HTTPS multipart transport (mocked, no network)', () => {
  it('POSTs exactly one streaming file with a matching multipart content length', async () => {
    const captured = mockHttp();
    const { storage, file } = await connected();
    expect((await storage.upload(OPERATION, 1, file)).url).toBe(reply().url);
    expect(network.request).toHaveBeenCalledOnce();
    const [url, options] = network.request.mock.calls[0];
    expect(url.toString()).toBe(`${SERVER}/api/uploads`);
    expect(options.method).toBe('POST');
    expect(options.agent).toBe(false);
    expect(options.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(options.headers.Accept).toBe('application/json');
    const bytes = Buffer.concat(captured.chunks);
    expect(options.headers['Content-Length']).toBe(bytes.length);
    expect(bytes.toString()).toContain('name="file"; filename="');
    expect(bytes.toString()).toContain('Content-Type: image/jpeg\r\n\r\nsynthetic-file\r\n');
    expect(bytes.toString().match(/Content-Disposition:/g)).toHaveLength(1);
    expect(bytes.toString()).not.toContain(TOKEN);
    expect(bytes.toString()).not.toContain(file.path);
    expect(captured.request?.destroyed).toBe(true);
  });

  it.each([
    [301, 'file_server_upload'],
    [302, 'file_server_upload'],
    [401, 'file_server_auth'],
    [403, 'file_server_auth'],
    [413, 'file_server_file'],
    [415, 'file_server_file'],
    [429, 'file_server_busy'],
    [507, 'file_server_capacity'],
    [500, 'file_server_upload'],
  ] as const)(
    'handles HTTP %i without redirect, retry, or raw error disclosure',
    async (status, code) => {
      mockHttp({ status, body: JSON.stringify({ message: TOKEN }) });
      const { storage, file } = await connected();
      await failure(storage.upload(OPERATION, 1, file), code);
      expect(network.request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { body: 'not json' },
    { contentType: 'text/html' },
    { body: JSON.stringify({ ...reply(), extra: true }) },
    { body: JSON.stringify({ message: 'a'.repeat(16 * 1024) }) },
  ])('rejects invalid or oversized success response %#', async (response) => {
    mockHttp(response);
    const { storage, file } = await connected();
    await failure(storage.upload(OPERATION, 1, file), 'file_server_response');
    expect(network.request).toHaveBeenCalledOnce();
  });
});
