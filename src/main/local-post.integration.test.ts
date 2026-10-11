import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { CollectionController, readRuntime } from './collection';
import { MediaRegistry } from './media';
import {
  LocalPostController,
  launchLocalPost,
  launchLocalPostRecovery,
  type LocalPostCommand,
} from './local-post';
import { launchPostDraftDelete } from './post-draft-delete';
import { pythonCommand } from './python';

it.each(['', '내가 직접 작성한 캡션'])(
  'imports, previews, retries and deletes a personal draft with caption %j through the real isolated workers',
  async (caption) => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'tmm-personal-worker-test-')));
    const root = join(directory, 'library');
    const original = join(directory, '외부 원본.png');
    const registry = new MediaRegistry();
    const collection = new CollectionController(
      (path) => readRuntime(process.cwd(), path),
      (path, files) => registry.adopt(path, files),
    );
    let command: LocalPostCommand | undefined;
    const launch = launchLocalPost(process.cwd());
    const controller = new LocalPostController(
      async () => [original],
      (path) => collection.refresh(path),
      (input) => {
        command = input;
        return launch(input);
      },
      () => collection.root,
      () => false,
      launchLocalPostRecovery(process.cwd()),
    );
    try {
      await mkdir(root);
      const python = pythonCommand(process.cwd());
      await promisify(execFile)(
        python.command,
        [
          ...python.prefix,
          '-I',
          '-B',
          '-c',
          'from PIL import Image; import sys; Image.new("RGB", (16, 12), (50, 100, 150)).save(sys.argv[1], "PNG")',
          original,
        ],
        { timeout: 10_000, windowsHide: true },
      );
      const bytes = await readFile(original);
      expect((await collection.refresh(root)).error).toBeNull();
      const selected = await controller.pick(root);
      expect(selected.status).toBe('selected');
      if (selected.status !== 'selected') throw new Error(JSON.stringify(selected));
      const added = await controller.add(root, {
        paths: [original],
        current: {
          selectionId: selected.selectionId,
          mediaIds: selected.files.map((file) => file.id),
        },
      });
      expect(added.status, JSON.stringify(added)).toBe('selected');
      if (added.status !== 'selected') throw new Error(JSON.stringify(added));
      expect(added.files).toHaveLength(2);
      expect(added.files[0]).toEqual(selected.files[0]);
      expect(added.files[1].id).not.toBe(added.files[0].id);
      const saved = await controller.create(root, {
        selectionId: added.selectionId,
        mediaIds: added.files.map((file) => file.id),
        caption,
      });
      expect(saved.status, JSON.stringify(saved)).toBe('saved');
      if (saved.status !== 'saved') throw new Error(JSON.stringify(saved));
      expect(saved.view.error).toBeNull();
      expect(saved.view.snapshot?.posts).toHaveLength(1);
      const post = saved.view.snapshot!.posts[0];
      expect(post).toMatchObject({
        origin: 'local',
        account: ':local:',
        originalUrl: '',
        downloadExcluded: true,
        draft: { caption, revision: 1 },
      });
      expect(post.sourceDeleted).not.toBe(true);
      expect(post.attachments).toHaveLength(2);
      expect(post.draft?.mediaIds).toEqual(added.files.map((file) => file.id));
      for (const attachment of post.attachments)
        expect(
          Buffer.from(
            await (await registry.respond(new Request(attachment.localUrl!))).arrayBuffer(),
          ),
        ).toEqual(bytes);
      expect(command).toBeDefined();
      expect(command!.files.map((file) => file.mediaId)).toEqual(
        added.files.map((file) => file.id),
      );
      for (const file of command!.files) await expect(readFile(file.path)).rejects.toThrow();
      const repeated = await launch(command!).result;
      expect(repeated.postKey).toBe(saved.postKey);
      expect((await collection.refresh(root)).snapshot?.posts).toHaveLength(1);
      await launchPostDraftDelete(process.cwd())({
        root,
        postKey: saved.postKey,
        kind: 'delete',
        expectedRevision: 1,
        expectedSourceDeleted: false,
      }).result;
      expect((await collection.refresh(root)).snapshot?.posts).toEqual([]);
      expect(await readFile(original)).toEqual(bytes);
    } finally {
      await controller.shutdown();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
