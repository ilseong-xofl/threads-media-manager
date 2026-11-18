import { describe, expect, it, vi } from 'vitest';
import type { CollectionView, PostDraft, SavePostDraftInput } from '../shared/contracts';
import { PostDraftController, parsePostDraftInput, parsePostDraftResult } from './post-draft';
import { validPostDraft } from '../shared/post-draft';
import { ViewError } from './collection';

const id = 'a'.repeat(32);
const second = 'b'.repeat(32);
const input = (): SavePostDraftInput => ({
  postKey: '["sample","post"]',
  caption: '새 캡션',
  mediaIds: [second, id],
  expectedRevision: null,
  accountId: 'account-a',
  translation: null,
});
const draft = (): PostDraft => ({
  caption: '새 캡션',
  mediaIds: [second, id],
  createdAt: '2026-09-22T01:00:00Z',
  updatedAt: '2026-09-22T01:00:00Z',
  revision: 1,
});
function view(saved?: PostDraft): CollectionView {
  return {
    error: null,
    snapshot: {
      root: '/collection',
      loadedAt: '2026-09-22T00:00:00Z',
      sourceCount: 1,
      stateStatus: 'read_only',
      warnings: [],
      posts: [
        {
          key: input().postKey,
          account: 'sample',
          postId: 'post',
          caption: '원문',
          originalUrl: 'https://www.threads.com/@sample/post/post',
          publishedAt: null,
          collectedAt: null,
          observedAt: null,
          captionObservedAt: null,
          captionStatus: 'complete',
          attachmentStatus: 'complete',
          runStatus: 'complete',
          gapStatus: '',
          reasons: [],
          source: 'results/example.xlsx',
          attachments: [
            {
              ordinal: 1,
              kind: 'image',
              status: 'saved',
              mediaId: id,
              localUrl: `threads-media://file/${id}`,
              addressStatus: '',
              observedAt: null,
              reason: null,
            },
          ],
          ...(saved ? { draft: saved } : {}),
        },
      ],
    },
  };
}
describe('post registration IPC', () => {
  it('does not launch a local save when the mobile publication guard requires recall', async () => {
    const launch = vi.fn(() => ({ result: Promise.resolve(draft()), cancel: vi.fn() }));
    const beforeSave = vi.fn(async () => {
      throw new Error('pending publication');
    });
    const controller = new PostDraftController(
      async () => view(draft()),
      launch,
      () => false,
      beforeSave,
    );
    expect((await controller.save('/collection', { ...input(), expectedRevision: 1 })).status).toBe(
      'error',
    );
    expect(beforeSave).toHaveBeenCalledOnce();
    expect(launch).not.toHaveBeenCalled();
  });
  it('preserves media order and user caption whitespace', () => {
    expect(parsePostDraftInput({ ...input(), caption: '  새 캡션  ' })).toEqual({
      ...input(),
      caption: '  새 캡션  ',
    });
    expect(
      parsePostDraftResult(
        JSON.stringify({ ok: true, postKey: input().postKey, draft: draft() }),
        input(),
      ),
    ).toEqual(draft());
  });
  it.each([
    { mediaIds: [] },
    { mediaIds: [id, id] },
    { mediaIds: ['../../secret'] },
    { mediaIds: [id.toUpperCase()] },
    { expectedRevision: 0 },
    { expectedRevision: 1.5 },
    { expectedRevision: '1' },
    { caption: 'x'.repeat(10001) },
    { caption: 'a\0b' },
    { root: '/another-root' },
    { accountId: '' },
    { accountId: 'has space' },
    { translation: '   ' },
    { translation: '가'.repeat(1001) },
  ])('rejects malformed request %j', (change) =>
    expect(() => parsePostDraftInput({ ...input(), ...change })).toThrow(),
  );
  it('rejects forged or stale successful worker output', () => {
    for (const change of [
      { revision: 2 },
      { mediaIds: [id, second] },
      { caption: 'different' },
      { createdAt: '2026-02-31T00:00:00Z' },
    ])
      expect(() =>
        parsePostDraftResult(
          JSON.stringify({ ok: true, postKey: input().postKey, draft: { ...draft(), ...change } }),
          input(),
        ),
      ).toThrow();
  });
  it('checks the account before the save and records it after, without undoing a saved draft', async () => {
    const refresh = vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(view(draft()));
    const launch = vi.fn(() => ({ result: Promise.resolve(draft()), cancel: vi.fn() }));
    const before = vi.fn<
      (view: CollectionView, post: unknown, input: SavePostDraftInput) => Promise<void>
    >(async () => {});
    const after = vi.fn(async () => true);
    const chosen = { ...input(), accountId: 'account-b', translation: '뜻' };
    const saved = await new PostDraftController(refresh, launch, undefined, before, after).save(
      '/collection',
      chosen,
    );
    expect(saved).toMatchObject({ status: 'saved', noteSaved: true });
    expect(before.mock.calls[0][2]).toEqual(chosen);
    expect(after).toHaveBeenCalledExactlyOnceWith(expect.anything(), draft(), chosen);
    // A refused account stops the save before the worker starts.
    const refused = vi.fn(async () => {
      throw new ViewError('draft_account_locked', '이미 보낸 글은 계정을 바꿀 수 없습니다.');
    });
    const blockedLaunch = vi.fn();
    const blocked = await new PostDraftController(
      async () => view(),
      blockedLaunch,
      undefined,
      refused,
      after,
    ).save('/collection', chosen);
    expect(blocked).toMatchObject({ status: 'error', problem: { code: 'draft_account_locked' } });
    expect(blockedLaunch).not.toHaveBeenCalled();
    // The draft is committed; a note that cannot be written only clears the flag.
    for (const failing of [async () => false, async () => Promise.reject(new Error('disk'))]) {
      const result = await new PostDraftController(
        vi.fn().mockResolvedValueOnce(view()).mockResolvedValue(view(draft())),
        () => ({ result: Promise.resolve(draft()), cancel: vi.fn() }),
        undefined,
        before,
        failing,
      ).save('/collection', chosen);
      expect(result).toMatchObject({ status: 'saved', noteSaved: false, draft: draft() });
    }
  });
  it('allows empty media-only caption and rejects duplicate persisted references', () => {
    expect(validPostDraft({ ...draft(), caption: '' })).toBe(true);
    expect(validPostDraft({ ...draft(), mediaIds: [id, id] })).toBe(false);
  });
  it('preserves saved result when refresh fails, without inviting a duplicate write', async () => {
    const refresh = vi
      .fn()
      .mockResolvedValueOnce(view())
      .mockRejectedValueOnce(new Error('offline'));
    const launch = vi.fn(() => ({ result: Promise.resolve(draft()), cancel: vi.fn() }));
    const result = await new PostDraftController(refresh, launch).save('/collection', input());
    expect(result.status).toBe('saved');
    if (result.status === 'saved') {
      expect(result.view.snapshot?.posts[0].draft).toEqual(draft());
      expect(result.view.error?.code).toBe('draft_refresh_failed');
    }
    // The account and the Korean rendering never reach the library worker.
    expect(launch).toHaveBeenCalledExactlyOnceWith({
      root: '/collection',
      postKey: input().postKey,
      caption: input().caption,
      mediaIds: input().mediaIds,
      expectedRevision: null,
    });
  });
  it('blocks concurrent operations and corrupt persisted drafts before writing', async () => {
    const launch = vi.fn(() => ({ result: Promise.resolve(draft()), cancel: vi.fn() }));
    const bad = view();
    bad.snapshot!.warnings = [{ code: 'drafts_unavailable', message: 'invalid' }];
    expect(
      (await new PostDraftController(async () => bad, launch).save('/collection', input())).status,
    ).toBe('error');
    expect(
      (
        await new PostDraftController(
          async () => view(),
          launch,
          () => true,
        ).save('/collection', input())
      ).status,
    ).toBe('error');
    expect(launch).not.toHaveBeenCalled();
  });
  it('does not resurrect a post removed after successful save', async () => {
    const removed = view();
    removed.snapshot!.posts = [];
    const refresh = vi.fn().mockResolvedValueOnce(view()).mockResolvedValueOnce(removed);
    const result = await new PostDraftController(refresh, () => ({
      result: Promise.resolve(draft()),
      cancel: vi.fn(),
    })).save('/collection', input());
    expect(result.status).toBe('saved');
    if (result.status === 'saved') expect(result.view.snapshot?.posts).toEqual([]);
  });
  it('stops before write when app closes during source refresh', async () => {
    let resolve!: (value: CollectionView) => void;
    const refresh = new Promise<CollectionView>((r) => {
      resolve = r;
    });
    const launch = vi.fn(() => ({ result: Promise.resolve(draft()), cancel: vi.fn() }));
    const controller = new PostDraftController(() => refresh, launch);
    const result = controller.save('/collection', input());
    const shutdown = controller.shutdown();
    resolve(view());
    await shutdown;
    expect((await result).status).toBe('error');
    expect(launch).not.toHaveBeenCalled();
  });
});
