import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export interface LocalFile {
  id: string;
  relativePath: string;
  size: number;
  sha256: string;
  kind: 'image' | 'video';
}
interface Registration extends LocalFile {
  root: string;
  stamp: string;
}
const signature = (s: Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

async function openLocal(root: string, file: LocalFile, includeAI: boolean): Promise<FileHandle> {
  const match =
    /^media\/files\/[a-f0-9]{32}\/([a-f0-9]{32})\.(jpg|jpeg|png|webp|gif|mp4|mov|webm)$/.exec(
      file.relativePath,
    );
  const ai = includeAI
    ? /^ai-drafts\/([a-f0-9]{32})\/([a-f0-9]{32})\/(0[12]\.(png|jpg|webp))$/.exec(file.relativePath)
    : null;
  const validOriginal =
    match &&
    match[1] === file.id &&
    (file.kind === 'image') === MIME[match[2]].startsWith('image/');
  const validAI =
    ai &&
    file.kind === 'image' &&
    file.id ===
      createHash('sha256').update(`ai:${ai[1]}:${ai[2]}:${ai[3]}`).digest('hex').slice(0, 32);
  if (!validOriginal && !validAI) throw new Error('Invalid registration');
  if ((await realpath(root)) !== root) throw new Error('Root changed');
  let path = root;
  for (const part of file.relativePath.split('/')) {
    path = join(path, part);
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Symlink');
  }
  const resolved = await realpath(path);
  const rel = relative(root, resolved);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error('Outside root');
  const before = await lstat(path);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (
      !after.isFile() ||
      after.nlink !== 1 ||
      after.size !== file.size ||
      signature(before) !== signature(after) ||
      (await realpath(path)) !== resolved
    )
      throw new Error('File changed');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Reused range semantics from local-video-manager, including suffix and HEAD.
export function byteRange(header: string, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || size <= 0 || (!m[1] && !m[2])) return null;
  if (!m[1]) {
    const suffix = Number(m[2]);
    return Number.isSafeInteger(suffix) && suffix > 0
      ? { start: Math.max(0, size - suffix), end: size - 1 }
      : null;
  }
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : size - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start < size &&
    end >= start
    ? { start, end: Math.min(size - 1, end) }
    : null;
}

export class MediaRegistry {
  constructor(private includeAI = false) {}
  private files = new Map<string, Registration>();
  async adopt(root: string, files: LocalFile[]): Promise<void> {
    const next = new Map<string, Registration>();
    for (const file of files) {
      if (next.has(file.id)) throw new Error('Duplicate registration');
      const handle = await openLocal(root, file, this.includeAI);
      try {
        const before = signature(await handle.stat());
        const digest = createHash('sha256');
        for await (const chunk of handle.createReadStream({ autoClose: false }))
          digest.update(chunk);
        if (digest.digest('hex') !== file.sha256 || signature(await handle.stat()) !== before)
          throw new Error('File changed');
        next.set(file.id, { ...file, root, stamp: before });
      } finally {
        await handle.close();
      }
    }
    this.files = next;
  }
  async respond(request: Request): Promise<Response> {
    if (!['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 405 });
    const match = /^threads-media:\/\/file\/([a-f0-9]{32})$/.exec(request.url);
    const file = match ? this.files.get(match[1]) : undefined;
    if (!file) return new Response(null, { status: 404 });
    let handle: FileHandle;
    try {
      handle = await openLocal(file.root, file, this.includeAI);
      if (signature(await handle.stat()) !== file.stamp) {
        await handle.close();
        return new Response(null, { status: 409 });
      }
    } catch {
      return new Response(null, { status: 404 });
    }
    const header = request.headers.get('range');
    const range = header ? byteRange(header, file.size) : null;
    const headers = new Headers({
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': MIME[file.relativePath.split('.').at(-1)!],
      'X-Content-Type-Options': 'nosniff',
    });
    // Only verified, registered local GET responses can be used by the editor's
    // anonymous image/video elements and drawn onto a readable canvas.
    if (request.method === 'GET') headers.set('Access-Control-Allow-Origin', '*');
    if (header && !range) {
      await handle.close();
      headers.set('Content-Range', `bytes */${file.size}`);
      return new Response(null, { status: 416, headers });
    }
    headers.set('Content-Length', String(range ? range.end - range.start + 1 : file.size));
    if (range) headers.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    if (request.method === 'HEAD') {
      await handle.close();
      return new Response(null, { status: range ? 206 : 200, headers });
    }
    const stream = handle.createReadStream(range ?? {});
    return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
      status: range ? 206 : 200,
      headers,
    });
  }
}
