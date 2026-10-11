import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CollectionView, LocalPostMediaSelection, PostDraft } from '../shared/contracts';
import {
  LocalPostController,
  parseAddLocalPostMediaInput,
  parseCreateLocalPostInput,
  parseLocalPostResult,
  type LocalPostCommand,
  type LocalPostReceipt,
} from './local-post';

const roots: string[] = [];
const controllers: LocalPostController[] = [];
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.shutdown()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const view = (root: string): CollectionView => ({
  snapshot: {
    root,
    loadedAt: '2026-10-12T00:00:00Z',
    sourceCount: 0,
    posts: [],
    warnings: [],
    stateStatus: 'read_only',
  },
  error: null,
});
const draft = (input: LocalPostCommand): PostDraft => ({
  caption: input.caption,
  mediaIds: input.files.map((file) => file.mediaId),
  revision: 1,
  createdAt: '2026-10-12T00:00:00Z',
  updatedAt: '2026-10-12T00:00:00Z',
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'tmm-local-input-test-')));
  roots.push(root);
  const image = join(root, 'my photo.png');
  const video = join(root, 'my video.mp4');
  await writeFile(image, 'test image bytes');
  await writeFile(video, 'test video bytes');
  const choose = vi.fn<() => Promise<string[] | null>>().mockResolvedValue([image, video]);
  const refresh = vi.fn().mockResolvedValue(view(root));
  const worker = vi.fn(async (input: LocalPostCommand): Promise<LocalPostReceipt> => ({
    postKey: JSON.stringify([':local:', input.postId]),
    draft: draft(input),
  }));
  const cancel = vi.fn();
  const launch = vi.fn((input: LocalPostCommand) => ({ result: worker(input), cancel }));
  let connectedRoot = root;
  const busy = vi.fn(() => false);
  const recovery = vi.fn(async () => {});
  const recover = vi.fn(() => ({ result: recovery(), cancel }));
  const controller = new LocalPostController(
    choose,
    refresh,
    launch,
    () => connectedRoot,
    busy,
    recover,
  );
  controllers.push(controller);
  const select = async (): Promise<LocalPostMediaSelection> => {
    const result = await controller.pick(root);
    expect(result.status).toBe('selected');
    if (result.status !== 'selected') throw new Error('Selection failed');
    return result;
  };
  return {
    root,
    image,
    video,
    choose,
    refresh,
    worker,
    launch,
    cancel,
    controller,
    select,
    busy,
    recover,
    recovery,
    changeRoot: (value: string) => {
      connectedRoot = value;
    },
  };
}

describe('private native-file staging', () => {
  it('recovers prior imports before reading the library or opening the native picker', async () => {
    const f = await fixture();
    await f.select();
    expect(f.recover).toHaveBeenCalledExactlyOnceWith(f.root);
    expect(f.recover.mock.invocationCallOrder[0]).toBeLessThan(
      f.refresh.mock.invocationCallOrder[0],
    );
    expect(f.refresh.mock.invocationCallOrder[0]).toBeLessThan(
      f.choose.mock.invocationCallOrder[0],
    );
  });
  it('exposes only opaque preview URLs and retains copied bytes when the source changes', async () => {
    const f = await fixture();
    const selection = await f.select();
    expect(selection.files.map((file) => [file.name, file.kind])).toEqual([
      ['my photo.png', 'image'],
      ['my video.mp4', 'video'],
    ]);
    expect(JSON.stringify(selection)).not.toContain(f.root);
    expect(Object.keys(selection.files[0]).sort()).toEqual(['id', 'kind', 'name', 'url']);
    await writeFile(f.image, 'source changed after selecting');
    const response = await f.controller.respond(new Request(selection.files[0].url));
    expect(await response.text()).toBe('test image bytes');
    const video = await f.controller.respond(
      new Request(selection.files[1].url, { headers: { range: 'bytes=5-9' } }),
    );
    expect(video.status).toBe(206);
    expect(video.headers.get('content-range')).toBe('bytes 5-9/16');
    expect(await video.text()).toBe('video');
    expect(
      (await f.controller.respond(new Request(selection.files[0].url, { method: 'POST' }))).status,
    ).toBe(405);
    await f.controller.discard(selection.selectionId);
    expect((await f.controller.respond(new Request(selection.files[0].url))).status).toBe(404);
    expect(await readFile(f.image, 'utf8')).toBe('source changed after selecting');
  });
  it('preserves the previous selection on native cancel and revokes previews on replacement', async () => {
    const f = await fixture();
    const first = await f.select();
    f.choose.mockResolvedValueOnce(null);
    expect(await f.controller.pick(f.root)).toEqual({ status: 'cancelled' });
    expect(
      (await f.controller.respond(new Request(first.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
    const second = await f.select();
    expect(second.selectionId).not.toBe(first.selectionId);
    expect((await f.controller.respond(new Request(first.files[0].url))).status).toBe(404);
    await f.controller.discard(first.selectionId);
    expect(
      (await f.controller.respond(new Request(second.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
  });
  it('rejects unsupported files, empty files, symbolic links and excessive selection counts', async () => {
    const f = await fixture();
    const empty = join(f.root, 'empty.png');
    const shortcut = join(f.root, 'shortcut.png');
    await writeFile(empty, '');
    await symlink(f.image, shortcut);
    for (const [paths, code] of [
      [[join(f.root, 'private.txt')], 'local_post_file'],
      [[empty], 'local_post_size'],
      [[shortcut], 'local_post_file'],
      [Array.from({ length: 101 }, () => f.image), 'local_post_count'],
    ] as [string[], string][]) {
      f.choose.mockResolvedValueOnce(paths);
      expect(await f.controller.pick(f.root)).toMatchObject({ status: 'error', problem: { code } });
    }
    expect(f.controller.hasSelection).toBe(false);
    expect(await readFile(f.image, 'utf8')).toBe('test image bytes');
  });
  it('blocks duplicate pickers and ignores a late native choice after window close', async () => {
    const f = await fixture();
    let resolve!: (value: string[]) => void;
    f.choose.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const pending = f.controller.pick(f.root);
    expect(await f.controller.pick(f.root)).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_busy' },
    });
    await vi.waitFor(() => expect(f.choose).toHaveBeenCalledOnce());
    await f.controller.shutdown();
    resolve([f.image]);
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(f.controller.hasSelection).toBe(false);
  });
});

describe('dropped file staging', () => {
  it('stages a dropped batch in order without opening the native picker or returning paths', async () => {
    const f = await fixture();
    const selected = await f.controller.add(f.root, { paths: [f.video, f.image] });
    expect(selected.status).toBe('selected');
    if (selected.status !== 'selected') throw new Error('Drop failed');
    expect(selected.files.map((file) => [file.name, file.kind])).toEqual([
      ['my video.mp4', 'video'],
      ['my photo.png', 'image'],
    ]);
    expect(JSON.stringify(selected)).not.toContain(f.root);
    expect(f.choose).not.toHaveBeenCalled();
    expect(f.recover).toHaveBeenCalledExactlyOnceWith(f.root);
    expect(f.launch).not.toHaveBeenCalled();
    expect(await readFile(f.image, 'utf8')).toBe('test image bytes');
  });

  it('appends after exactly the retained order and never revives excluded items', async () => {
    const f = await fixture();
    const original = await f.select();
    const added = await f.controller.add(f.root, {
      paths: [f.image],
      current: { selectionId: original.selectionId, mediaIds: [original.files[1].id] },
    });
    expect(added.status).toBe('selected');
    if (added.status !== 'selected') throw new Error('Drop failed');
    expect(added.selectionId).not.toBe(original.selectionId);
    expect(added.files.map((file) => file.name)).toEqual(['my video.mp4', 'my photo.png']);
    expect(added.files[0]).toEqual(original.files[1]);
    expect(added.files[1].id).not.toBe(original.files[0].id);
    expect((await f.controller.respond(new Request(original.files[0].url))).status).toBe(404);
    const reordered = await f.controller.add(f.root, {
      paths: [f.video],
      current: { selectionId: added.selectionId, mediaIds: [added.files[1].id, added.files[0].id] },
    });
    expect(reordered.status).toBe('selected');
    if (reordered.status !== 'selected') throw new Error('Drop failed');
    expect(reordered.files.slice(0, 2)).toEqual([added.files[1], added.files[0]]);
    await f.controller.discard(added.selectionId);
    expect(
      (await f.controller.respond(new Request(reordered.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
    expect(await readFile(f.video, 'utf8')).toBe('test video bytes');
  });

  it('preserves the existing selection when any added file is unsupported or the combined count exceeds 100', async () => {
    const f = await fixture();
    const original = await f.select();
    const current = {
      selectionId: original.selectionId,
      mediaIds: original.files.map((file) => file.id),
    };
    expect(
      await f.controller.add(f.root, { paths: [f.image, join(f.root, 'bad.txt')], current }),
    ).toMatchObject({ status: 'error', problem: { code: 'local_post_file' } });
    expect(
      await f.controller.add(f.root, { paths: Array.from({ length: 99 }, () => f.image), current }),
    ).toMatchObject({ status: 'error', problem: { code: 'local_post_count' } });
    for (const file of original.files)
      expect((await f.controller.respond(new Request(file.url, { method: 'HEAD' }))).status).toBe(
        200,
      );
    expect(f.launch).not.toHaveBeenCalled();
    expect((await f.controller.add(f.root, { paths: [f.image], current })).status).toBe('selected');
  });

  it('allows dropping new files after all prior attachments were excluded', async () => {
    const f = await fixture();
    const original = await f.select();
    const replaced = await f.controller.add(f.root, {
      paths: [f.image],
      current: { selectionId: original.selectionId, mediaIds: [] },
    });
    expect(replaced.status).toBe('selected');
    if (replaced.status !== 'selected') throw new Error('Drop failed');
    expect(replaced.files).toHaveLength(1);
    for (const file of original.files)
      expect((await f.controller.respond(new Request(file.url))).status).toBe(404);
  });

  it('rejects stale IDs and folder changes without replacing existing previews', async () => {
    const f = await fixture();
    const original = await f.select();
    const current = { selectionId: original.selectionId, mediaIds: [original.files[0].id] };
    for (const changed of [
      { ...current, selectionId: 'f'.repeat(32) },
      { ...current, mediaIds: ['f'.repeat(32)] },
    ]) {
      expect(await f.controller.add(f.root, { paths: [f.image], current: changed })).toMatchObject({
        status: 'error',
        problem: { code: 'local_post_selection' },
      });
    }
    f.changeRoot(join(f.root, 'different'));
    expect(await f.controller.add(f.root, { paths: [f.image], current })).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_folder' },
    });
    expect(
      (await f.controller.respond(new Request(original.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
  });

  it('cancels an in-flight append when its selection is discarded and blocks simultaneous requests', async () => {
    const f = await fixture();
    const original = await f.select();
    let resolve!: () => void;
    f.recovery.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const pending = f.controller.add(f.root, {
      paths: [f.video],
      current: { selectionId: original.selectionId, mediaIds: [original.files[0].id] },
    });
    expect(await f.controller.add(f.root, { paths: [f.image] })).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_busy' },
    });
    const discarded = f.controller.discard(original.selectionId);
    resolve();
    await discarded;
    expect(await pending).toEqual({ status: 'cancelled' });
    expect(f.controller.hasSelection).toBe(false);
    expect((await f.controller.respond(new Request(original.files[0].url))).status).toBe(404);
    expect(f.launch).not.toHaveBeenCalled();
  });

  it('validates internal path and selection payloads and clones arrays before asynchronous use', async () => {
    const f = await fixture();
    const current = { selectionId: 'a'.repeat(32), mediaIds: ['b'.repeat(32)] };
    const input = { paths: [f.image], current };
    const copied = parseAddLocalPostMediaInput(input);
    input.paths[0] = f.video;
    input.current.mediaIds[0] = 'c'.repeat(32);
    expect(copied.paths).toEqual([f.image]);
    expect(copied.current?.mediaIds).toEqual(['b'.repeat(32)]);
    for (const value of [
      null,
      {},
      { paths: [] },
      { paths: ['relative.png'] },
      { paths: [f.image + '\0'] },
      { paths: [f.image], root: f.root },
      { paths: [f.image], current: null },
      { paths: [f.image], current: { ...current, mediaIds: ['b'.repeat(32), 'b'.repeat(32)] } },
    ])
      expect(() => parseAddLocalPostMediaInput(value)).toThrow();
  });
});

describe('personal post creation boundary', () => {
  it('retains selection when recovery fails and does not run the import worker', async () => {
    const f = await fixture();
    const selected = await f.select();
    f.recovery.mockRejectedValueOnce(new Error('Cannot recover prior import'));
    const result = await f.controller.create(f.root, {
      selectionId: selected.selectionId,
      mediaIds: [selected.files[0].id],
      caption: 'keep this caption',
    });
    expect(result.status).toBe('error');
    expect(f.launch).not.toHaveBeenCalled();
    expect(
      (await f.controller.respond(new Request(selected.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
  });
  it('sends only selected files in user order and consumes temporary data after a committed save', async () => {
    const f = await fixture();
    const selection = await f.select();
    f.refresh
      .mockResolvedValueOnce(view(f.root))
      .mockRejectedValueOnce(new Error('Refresh failed'));
    const result = await f.controller.create(f.root, {
      selectionId: selection.selectionId,
      mediaIds: selection.files.map((file) => file.id).reverse(),
      caption: ' 직접 쓴 글\n ',
    });
    expect(result).toMatchObject({
      status: 'saved',
      postKey: JSON.stringify([':local:', selection.selectionId]),
      view: { error: { code: 'local_post_refresh_failed' } },
    });
    const command = f.launch.mock.calls[0][0];
    expect(command).toMatchObject({
      root: f.root,
      postId: selection.selectionId,
      caption: ' 직접 쓴 글\n ',
    });
    expect(command.files.map((file) => file.kind)).toEqual(['video', 'image']);
    expect(command.files[1].sha256).toBe(
      createHash('sha256').update('test image bytes').digest('hex'),
    );
    expect(command.files[1].size).toBe(16);
    for (const file of command.files) await expect(readFile(file.path)).rejects.toThrow();
    expect(await readFile(f.image, 'utf8')).toBe('test image bytes');
    expect(
      await f.controller.create(f.root, {
        selectionId: selection.selectionId,
        mediaIds: [selection.files[0].id],
        caption: '',
      }),
    ).toMatchObject({ status: 'error', problem: { code: 'local_post_selection' } });
    expect(f.launch).toHaveBeenCalledOnce();
  });
  it('rejects forged paths, unselected IDs, stale folders and corrupt storage before worker launch', async () => {
    const f = await fixture();
    const selection = await f.select();
    const input = {
      selectionId: selection.selectionId,
      mediaIds: [selection.files[0].id],
      caption: '',
    };
    expect(await f.controller.create(f.root, { ...input, path: '/secret' })).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_input' },
    });
    expect(
      await f.controller.create(f.root, { ...input, mediaIds: ['f'.repeat(32)] }),
    ).toMatchObject({ status: 'error', problem: { code: 'local_post_selection' } });
    f.changeRoot('/different');
    expect(await f.controller.create(f.root, input)).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_folder' },
    });
    f.changeRoot(f.root);
    const corrupt = view(f.root);
    corrupt.snapshot!.warnings.push({ code: 'local_posts_unavailable', message: 'corrupt' });
    f.refresh.mockResolvedValueOnce(corrupt);
    expect(await f.controller.create(f.root, input)).toMatchObject({
      status: 'error',
      problem: { code: 'local_posts_unavailable' },
    });
    expect(f.launch).not.toHaveBeenCalled();
  });
  it('blocks concurrent saves and retains previews plus the same post identity for safe retries', async () => {
    const f = await fixture();
    const selection = await f.select();
    const input = {
      selectionId: selection.selectionId,
      mediaIds: [selection.files[0].id],
      caption: '',
    };
    let reject!: (error: Error) => void;
    f.worker.mockImplementationOnce(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const pending = f.controller.create(f.root, input);
    await vi.waitFor(() => expect(f.worker).toHaveBeenCalledOnce());
    expect(await f.controller.create(f.root, input)).toMatchObject({
      status: 'error',
      problem: { code: 'local_post_busy' },
    });
    await f.controller.discard(selection.selectionId);
    reject(new Error('Unknown result'));
    expect((await pending).status).toBe('error');
    expect(
      (await f.controller.respond(new Request(selection.files[0].url, { method: 'HEAD' }))).status,
    ).toBe(200);
    expect(await f.controller.create(f.root, input)).toMatchObject({ status: 'saved' });
    expect(f.launch).toHaveBeenCalledTimes(2);
    expect(f.launch.mock.calls[0][0].postId).toBe(f.launch.mock.calls[1][0].postId);
  });
  it('validates worker receipts against the requested post identity, caption and ordered media', () => {
    const command: LocalPostCommand = {
      root: '/root',
      postId: 'a'.repeat(32),
      caption: 'mine',
      files: [
        {
          path: '/tmp/photo.png',
          mediaId: 'b'.repeat(32),
          kind: 'image',
          size: 1,
          sha256: 'c'.repeat(64),
        },
      ],
    };
    const receipt = {
      ok: true,
      postKey: JSON.stringify([':local:', command.postId]),
      draft: draft(command),
    };
    expect(parseLocalPostResult(JSON.stringify(receipt), command).draft).toEqual(draft(command));
    for (const value of [
      { ...receipt, postKey: '["other","post"]' },
      { ...receipt, draft: { ...receipt.draft, caption: 'wrong' } },
      { ...receipt, draft: { ...receipt.draft, mediaIds: ['d'.repeat(32)] } },
      { ...receipt, draft: { ...receipt.draft, revision: 2 } },
      { ok: true },
    ])
      expect(() => parseLocalPostResult(JSON.stringify(value), command)).toThrow(
        '등록 결과를 확인하지 못했습니다',
      );
    expect(() =>
      parseCreateLocalPostInput({ selectionId: command.postId, caption: '', mediaIds: [] }),
    ).toThrow();
  });
});
