import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { MobilePublicationMedia } from '../shared/mobile-publications';
import { isObject } from './managed-threads-store';
import { timestamp } from './mobile-publication-data';
import { ServiceApiError } from './service-api';

export interface PublicationUploadUrl {
  mediaId: string;
  method: 'PUT';
  url: string;
  headers: Record<string, string>;
  expiresAt: string;
}
const fail = (): never => {
  throw new ServiceApiError(
    '미디어 전송 주소나 파일을 확인하지 못했습니다.',
    'PUBLICATION_UPLOAD_INVALID',
    400,
  );
};
const stamp = (s: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
  `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

/** Digest the actual prepared bytes, including any WebP-to-PNG conversion. */
export async function preparedFileDigest(path: string): Promise<{ size: number; sha256: string }> {
  const before = await lstat(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size <= 0 ||
    before.size > 1024 ** 3
  )
    return fail();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (stamp(await file.stat()) !== stamp(before)) return fail();
    const digest = createHash('sha256');
    let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      digest.update(chunk);
      bytes += chunk.length;
    }
    if (bytes !== before.size || stamp(await file.stat()) !== stamp(before)) return fail();
    return { size: bytes, sha256: digest.digest('hex') };
  } finally {
    await file.close();
  }
}

export function parseUploadUrls(
  value: unknown,
  media: MobilePublicationMedia[],
): PublicationUploadUrl[] {
  if (!isObject(value) || !Array.isArray(value.uploads) || value.uploads.length !== media.length)
    return fail();
  const result = value.uploads.map((v): PublicationUploadUrl => {
    if (
      !isObject(v) ||
      typeof v.mediaId !== 'string' ||
      v.method !== 'PUT' ||
      typeof v.url !== 'string' ||
      v.url.length > 16384 ||
      !isObject(v.headers) ||
      !timestamp(v.expiresAt)
    )
      return fail();
    const item = media.find((m) => m.id === v.mediaId);
    if (!item) return fail();
    let url: URL;
    try {
      url = new URL(v.url);
    } catch {
      return fail();
    }
    const virtual = /^[a-z0-9][a-z0-9.-]{1,62}\.s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname);
    const regional =
      /^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) &&
      /^\/[a-z0-9][a-z0-9.-]{1,62}\/.+/.test(url.pathname);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      url.hash ||
      !(virtual || regional) ||
      !url.searchParams.has('X-Amz-Signature') ||
      url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
    )
      return fail();
    const headers: Record<string, string> = {};
    for (const [name, val] of Object.entries(v.headers)) {
      const lower = name.toLowerCase();
      if (
        !['content-type', 'content-length', 'x-amz-checksum-sha256', 'if-none-match'].includes(
          lower,
        ) ||
        typeof val !== 'string' ||
        /[\r\n]/.test(val) ||
        Object.hasOwn(headers, lower)
      )
        return fail();
      headers[lower] = val;
    }
    if (
      headers['content-type'] !== item.contentType ||
      headers['x-amz-checksum-sha256'] !== Buffer.from(item.sha256, 'hex').toString('base64') ||
      headers['if-none-match'] !== '*' ||
      (headers['content-length'] !== undefined && headers['content-length'] !== String(item.size))
    )
      return fail();
    return { mediaId: item.id, method: 'PUT', url: v.url, headers, expiresAt: v.expiresAt };
  });
  if (new Set(result.map((v) => v.mediaId)).size !== media.length) return fail();
  return result;
}

/** Direct PC-to-S3 only; never attach the service bearer or follow redirects. */
export async function uploadPublicationFile(
  path: string,
  media: MobilePublicationMedia,
  signed: PublicationUploadUrl,
  requestFetch: typeof fetch = fetch,
  authSignal?: AbortSignal,
): Promise<void> {
  const verified = parseUploadUrls({ uploads: [signed] }, [media])[0];
  if (Date.parse(verified.expiresAt) <= Date.now())
    throw new ServiceApiError(
      '미디어 전송 주소가 만료되었습니다. 전송 재시도를 눌러 주세요.',
      'PUBLICATION_UPLOAD_EXPIRED',
      400,
    );
  const digest = await preparedFileDigest(path);
  if (digest.size !== media.size || digest.sha256 !== media.sha256) return fail();
  const before = await lstat(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  const abort = new AbortController();
  const authAbort = () => abort.abort();
  if (authSignal?.aborted) abort.abort();
  authSignal?.addEventListener('abort', authAbort, { once: true });
  const timer = setTimeout(() => abort.abort(), 30 * 60 * 1000);
  const stream = file.createReadStream({ autoClose: false });
  try {
    if (
      stamp(await file.stat()) !== stamp(before) ||
      before.nlink !== 1 ||
      !before.isFile() ||
      before.isSymbolicLink()
    )
      return fail();
    if (authSignal?.aborted)
      throw new ServiceApiError('로그인 상태가 변경되어 전송을 중단했습니다.', 'AUTH_CHANGED', 401);
    const options = {
      method: 'PUT',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
      headers: { ...verified.headers, 'content-length': String(media.size) },
      body: stream,
      duplex: 'half',
      signal: abort.signal,
    } as unknown as RequestInit;
    const response = await requestFetch(verified.url, options);
    await response.body?.cancel();
    // Conditional PUT may already have succeeded before a lost response. The
    // API's complete operation must compare the stored checksum before ready.
    if (!response.ok && response.status !== 412) throw new Error('upload rejected');
    if (stamp(await file.stat()) !== stamp(before)) return fail();
  } catch (error) {
    if (error instanceof ServiceApiError) throw error;
    throw new ServiceApiError(
      'S3 미디어 전송을 확인하지 못했습니다. 같은 전송을 재시도하거나 취소하세요.',
      'PUBLICATION_UPLOAD_FAILED',
      400,
    );
  } finally {
    clearTimeout(timer);
    authSignal?.removeEventListener('abort', authAbort);
    stream.destroy();
    await file.close();
  }
}
