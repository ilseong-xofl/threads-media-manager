import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MobilePublicationMedia } from '../shared/mobile-publications';
import {
  parseUploadUrls,
  preparedFileDigest,
  uploadPublicationFile,
  type PublicationUploadUrl,
} from './publication-s3-upload';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tmm-direct-s3-test-'));
  roots.push(root);
  const path = join(root, '1.png');
  await writeFile(path, 'only-synthetic-bytes');
  const digest = await preparedFileDigest(path);
  const media: MobilePublicationMedia = {
    id: randomUUID(),
    ordinal: 0,
    kind: 'image',
    contentType: 'image/png',
    ...digest,
  };
  const signed: PublicationUploadUrl = {
    mediaId: media.id,
    method: 'PUT',
    url: 'https://bucket-test.s3.ap-northeast-2.amazonaws.com/threads/dev/staging/1?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=synthetic',
    headers: {
      'content-type': 'image/png',
      'content-length': String(media.size),
      'if-none-match': '*',
      'x-amz-checksum-sha256': Buffer.from(media.sha256, 'hex').toString('base64'),
    },
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  return { path, media, signed };
}
describe('PC direct S3 transport', () => {
  it('streams only verified bytes with no bearer, cookies, User-Agent override or redirects', async () => {
    const f = await setup();
    let data = '';
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      for await (const chunk of options!.body as unknown as Readable) data += chunk.toString();
      return new Response(null, { status: 200 });
    });
    await uploadPublicationFile(f.path, f.media, f.signed, fetcher);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe(f.signed.url);
    expect(options).toMatchObject({
      method: 'PUT',
      redirect: 'error',
      credentials: 'omit',
      cache: 'no-store',
    });
    expect(new Headers(options!.headers).has('Authorization')).toBe(false);
    expect(new Headers(options!.headers).has('User-Agent')).toBe(false);
    expect(new Headers(options!.headers).has('Cookie')).toBe(false);
    expect(data).toBe('only-synthetic-bytes');
    expect(createHash('sha256').update(data).digest('hex')).toBe(f.media.sha256);
    expect((options!.body as unknown as Readable).destroyed).toBe(true);
  });
  it.each([412, 403, 302])(
    'destroys an unconsumed request stream after an early %s response',
    async (status) => {
      const f = await setup();
      const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status }));
      const call = uploadPublicationFile(f.path, f.media, f.signed, fetcher);
      if (status === 412) await expect(call).resolves.toBeUndefined();
      else await expect(call).rejects.toMatchObject({ code: 'PUBLICATION_UPLOAD_FAILED' });
      expect((fetcher.mock.calls[0][1]!.body as unknown as Readable).destroyed).toBe(true);
      // A failed/early response leaves no stream owning the next verified upload.
      await uploadPublicationFile(
        f.path,
        f.media,
        f.signed,
        vi.fn<typeof fetch>(async (_u, options) => {
          for await (const chunk of options!.body as unknown as Readable) {
            void chunk;
            /* Drain synthetic body. */
          }
          return new Response(null, { status: 200 });
        }),
      );
    },
  );
  it('rejects altered bytes before any network request', async () => {
    const f = await setup();
    await writeFile(f.path, 'changed-bytes');
    const fetcher = vi.fn<typeof fetch>();
    await expect(uploadPublicationFile(f.path, f.media, f.signed, fetcher)).rejects.toMatchObject({
      code: 'PUBLICATION_UPLOAD_INVALID',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    'http://bucket-test.s3.ap-northeast-2.amazonaws.com/x',
    'https://bucket-test.s3.ap-northeast-2.amazonaws.com.evil.test/x',
    'https://graph.threads.com/x',
    'https://admin.example.test/x',
    'https://name:secret@bucket-test.s3.ap-northeast-2.amazonaws.com/x',
    'https://127.0.0.1/x',
  ])('rejects non-S3 or credential-bearing URL %s', async (url) => {
    const f = await setup();
    expect(() =>
      parseUploadUrls(
        {
          uploads: [
            { ...f.signed, url: url + '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=x' },
          ],
        },
        [f.media],
      ),
    ).toThrow();
  });
  it('supports the regional path-style URL used for dotted buckets and rejects additional headers', async () => {
    const f = await setup();
    expect(
      parseUploadUrls(
        {
          uploads: [
            {
              ...f.signed,
              url: f.signed.url.replace(
                'bucket-test.s3.ap-northeast-2.amazonaws.com/threads',
                's3.ap-northeast-2.amazonaws.com/bucket.test/threads',
              ),
            },
          ],
        },
        [f.media],
      ),
    ).toHaveLength(1);
    for (const headers of [
      { ...f.signed.headers, Authorization: 'Bearer bad' },
      { ...f.signed.headers, cookie: 'bad' },
      { ...f.signed.headers, 'x-amz-checksum-sha256': 'wrong' },
      { ...f.signed.headers, 'if-none-match': '' },
    ])
      expect(() => parseUploadUrls({ uploads: [{ ...f.signed, headers }] }, [f.media])).toThrow();
  });
  it('does not begin a PUT for an expired URL or revoked service context', async () => {
    const f = await setup();
    const fetcher = vi.fn<typeof fetch>();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadPublicationFile(f.path, f.media, f.signed, fetcher, controller.signal),
    ).rejects.toMatchObject({ code: 'AUTH_CHANGED' });
    await expect(
      uploadPublicationFile(
        f.path,
        f.media,
        { ...f.signed, expiresAt: '2020-01-01T00:00:00.000Z' },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: 'PUBLICATION_UPLOAD_EXPIRED' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('aborts an in-flight PUT when service access is revoked', async () => {
    const f = await setup();
    const auth = new AbortController();
    const fetcher = vi.fn<typeof fetch>(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          });
          auth.abort();
        }),
    );
    await expect(
      uploadPublicationFile(f.path, f.media, f.signed, fetcher, auth.signal),
    ).rejects.toMatchObject({ code: 'PUBLICATION_UPLOAD_FAILED' });
    expect((fetcher.mock.calls[0][1]!.body as unknown as Readable).destroyed).toBe(true);
  });
});
