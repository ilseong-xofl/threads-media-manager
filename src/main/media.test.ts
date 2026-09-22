import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MediaRegistry, byteRange, type LocalFile } from './media';
let root: string;
let file: LocalFile;
const url = `threads-media://file/${'a'.repeat(32)}`;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'tmm-media-')));
  file = {
    id: 'a'.repeat(32),
    relativePath: `media/files/${'b'.repeat(32)}/${'a'.repeat(32)}.mp4`,
    size: 10,
    sha256: createHash('sha256').update('0123456789').digest('hex'),
    kind: 'video',
  };
  await mkdir(join(root, 'media/files', 'b'.repeat(32)), { recursive: true });
  await writeFile(join(root, file.relativePath), '0123456789');
});
afterEach(() => rm(root, { recursive: true, force: true }));
describe('local media response', () => {
  it('streams full bytes, byte ranges, suffixes, and HEAD without network', async () => {
    const registry = new MediaRegistry();
    await registry.adopt(root, [file]);
    const full = await registry.respond(new Request(url));
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('access-control-allow-origin')).toBe('*');
    expect(await full.text()).toBe('0123456789');
    for (const [range, body] of [
      ['bytes=2-4', '234'],
      ['bytes=-3', '789'],
      ['bytes=8-', '89'],
    ]) {
      const response = await registry.respond(new Request(url, { headers: { range } }));
      expect(response.status).toBe(206);
      expect(await response.text()).toBe(body);
    }
    const head = await registry.respond(new Request(url, { method: 'HEAD' }));
    expect(head.headers.get('content-length')).toBe('10');
    expect(await head.text()).toBe('');
  });
  it('refuses invalid ranges, unknown IDs, traversal, and writes', async () => {
    const registry = new MediaRegistry();
    await registry.adopt(root, [file]);
    const response = await registry.respond(new Request(url, { headers: { range: 'bytes=99-' } }));
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect((await registry.respond(new Request(url + '?path=/etc/passwd'))).status).toBe(404);
    expect((await registry.respond(new Request(url.replace('a', 'd')))).status).toBe(404);
    expect((await registry.respond(new Request(url, { method: 'POST' }))).status).toBe(405);
  });
  it('rejects hash changes and does not replace prior registrations on failure', async () => {
    const registry = new MediaRegistry();
    await registry.adopt(root, [file]);
    await expect(registry.adopt(root, [{ ...file, sha256: '0'.repeat(64) }])).rejects.toThrow();
    expect(await (await registry.respond(new Request(url))).text()).toBe('0123456789');
    await writeFile(join(root, file.relativePath), '9876543210');
    expect((await registry.respond(new Request(url))).status).toBe(409);
  });
  it('rejects symlink swaps and paths outside the collection', async () => {
    const registry = new MediaRegistry();
    await registry.adopt(root, [file]);
    await unlink(join(root, file.relativePath));
    await writeFile(join(root, 'outside'), '0123456789');
    await symlink(join(root, 'outside'), join(root, file.relativePath));
    expect((await registry.respond(new Request(url))).status).toBe(404);
    await expect(registry.adopt(root, [{ ...file, relativePath: '../outside' }])).rejects.toThrow();
  });
});
it.each(['bytes=-0', 'bytes=5-2', 'bytes=0-1,5-6', 'bytes=999999999999999999999-', 'bad'])(
  'rejects malformed range %s',
  (value) => {
    expect(byteRange(value, 10)).toBeNull();
  },
);
