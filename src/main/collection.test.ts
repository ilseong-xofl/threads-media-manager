import { describe, it, expect, vi } from 'vitest';
import {
  CollectionController,
  parseRuntimeResult,
  ViewError,
  type RuntimeResult,
} from './collection';

const data = (): RuntimeResult => ({
  snapshot: {
    root: '/example',
    loadedAt: '2026-09-21',
    sourceCount: 1,
    posts: [],
    warnings: [],
    stateStatus: 'absent',
  },
  files: [],
});
const editedOutput = (kind = 'video', editType = 'trim') => {
  const originalId = 'a'.repeat(32);
  const editId = 'b'.repeat(32);
  const attachment = {
    ordinal: 1,
    kind: 'video',
    addressStatus: 'missing',
    observedAt: null,
    status: 'saved',
    reason: null,
    mediaId: originalId,
    localUrl: `threads-media://file/${originalId}`,
  };
  return {
    ok: true,
    snapshot: {
      ...data().snapshot,
      stateStatus: 'read_only',
      posts: [
        {
          key: '["fixture","post"]',
          account: 'fixture',
          postId: 'post',
          originalUrl: '',
          publishedAt: null,
          collectedAt: null,
          observedAt: null,
          captionObservedAt: null,
          caption: '',
          captionStatus: 'complete',
          attachmentStatus: 'complete',
          runStatus: 'initial_complete',
          gapStatus: 'not_applicable',
          reasons: [],
          source: 'results/2026/09/threads-2026-09-22.xlsx',
          attachments: [attachment],
          edits: [
            {
              ...attachment,
              ordinal: 2,
              kind,
              mediaId: editId,
              localUrl: `threads-media://file/${editId}`,
              editType,
              sourceMediaId: originalId,
              createdAt: '2026-09-22T03:00:00+00:00',
            },
          ],
        },
      ],
    },
    files: [originalId, editId].map((id, index) => ({
      id,
      relativePath: `media/files/${'c'.repeat(32)}/${id}.${index === 0 || kind === 'video' ? 'mp4' : 'png'}`,
      size: 10,
      sha256: 'd'.repeat(64),
      kind: index === 0 ? 'video' : kind,
    })),
  };
};
describe('snapshot adoption', () => {
  it('retains the last good snapshot on incomplete source and never changes the registry', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce(data())
      .mockRejectedValueOnce(new ViewError('invalid_workbook', 'Incomplete'));
    const adopt = vi.fn().mockResolvedValue(undefined);
    const controller = new CollectionController(load, adopt);
    const first = await controller.refresh('/example');
    const second = await controller.refresh();
    expect(second.snapshot).toBe(first.snapshot);
    expect(second.error?.code).toBe('invalid_workbook');
    expect(adopt).toHaveBeenCalledTimes(1);
  });
  it('coalesces concurrent refreshes and adopts only verified registrations', async () => {
    const load = vi.fn().mockResolvedValue(data());
    const adopt = vi.fn().mockRejectedValue(new Error('Changed local file'));
    const controller = new CollectionController(load, adopt);
    const results = await Promise.all([controller.refresh('/example'), controller.refresh()]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(results[0].snapshot).toBeNull();
    expect(results[1].error?.code).toBe('read_failed');
  });
});
describe('runtime response boundary', () => {
  it('accepts optional per-post comments without changing media or old snapshot contracts', () => {
    const input = editedOutput();
    const comment = {
      caption: '첫 댓글\n다음 줄',
      link: 'https://example.test/item',
      updatedAt: '2026-09-22T03:00:00.123456+00:00',
    };
    Object.assign(input.snapshot.posts[0], { comment });
    const parsed = parseRuntimeResult(JSON.stringify(input), '/example');
    expect(parsed.snapshot.posts[0].comment).toEqual(comment);
    expect(parsed.snapshot.posts[0].attachments).toEqual(input.snapshot.posts[0].attachments);
    expect(parsed.files).toEqual(input.files);
    expect(
      parseRuntimeResult(JSON.stringify(editedOutput()), '/example').snapshot.posts[0],
    ).not.toHaveProperty('comment');
  });
  it.each([
    { caption: '본문만', link: '' },
    { caption: '', link: 'HTTP://example.test/item' },
    { caption: '🙂'.repeat(5000), link: '' },
  ])('accepts a valid local comment %j', ({ caption, link }) => {
    const input = editedOutput();
    Object.assign(input.snapshot.posts[0], {
      comment: { caption, link, updatedAt: '2026-09-22T03:00:00Z' },
    });
    expect(
      parseRuntimeResult(JSON.stringify(input), '/example').snapshot.posts[0].comment?.caption,
    ).toBe(caption);
  });
  it.each([
    null,
    'not an object',
    {},
    { caption: '', link: '' },
    { caption: 42 },
    { caption: '🙂'.repeat(5001) },
    { caption: ' padded ' },
    { caption: '\u0000broken' },
    { link: 'javascript:alert(1)' },
    { link: 'https:example.test' },
    { link: 'https://user:password@example.test' },
    { link: 'https://@example.test' },
    { link: 'https://example.test:99999' },
    { link: 'https://example.test/with space' },
    { link: 'https://example.test/\\path' },
    { link: 'https://' + 'a'.repeat(2048) },
    { updatedAt: 'not-a-date' },
    { updatedAt: '2026-02-31T03:00:00Z' },
    { updatedAt: '2026-09-22T03:00:00' },
    { updatedAt: '2026-09-22T03:00:00+09:00' },
  ])('rejects malformed comments instead of treating them as an empty draft %#', (change) => {
    const input = editedOutput();
    const comment =
      change === null || typeof change !== 'object' || Object.keys(change).length === 0
        ? change
        : { caption: '기존 댓글', link: '', updatedAt: '2026-09-22T03:00:00Z', ...change };
    Object.assign(input.snapshot.posts[0], { comment });
    expect(() => parseRuntimeResult(JSON.stringify(input), '/example')).toThrow(ViewError);
  });
  it('preserves appended video trims and their local video registrations', () => {
    const input = editedOutput();
    const parsed = parseRuntimeResult(JSON.stringify(input), '/example');
    expect(parsed.snapshot.posts[0].attachments).toHaveLength(1);
    expect(parsed.snapshot.posts[0].edits?.[0]).toMatchObject({
      ordinal: 2,
      kind: 'video',
      editType: 'trim',
      sourceMediaId: 'a'.repeat(32),
    });
    expect(parsed.files[1]).toMatchObject({
      kind: 'video',
      relativePath: expect.stringMatching(/\.mp4$/),
    });
  });
  it.each([
    ['image', 'crop'],
    ['image', 'capture'],
  ])('keeps existing %s %s edits compatible', (kind, editType) => {
    expect(
      parseRuntimeResult(JSON.stringify(editedOutput(kind, editType)), '/example').snapshot.posts[0]
        .edits?.[0].editType,
    ).toBe(editType);
  });
  it.each([
    ['image', 'trim'],
    ['video', 'crop'],
    ['video', 'capture'],
    ['video', 'unknown'],
  ])('rejects incompatible edit kind/type %s %s', (kind, editType) => {
    expect(() =>
      parseRuntimeResult(JSON.stringify(editedOutput(kind, editType)), '/example'),
    ).toThrow(ViewError);
  });
  it('accepts the view contract and propagates sanitized source failures', () => {
    expect(parseRuntimeResult(JSON.stringify({ ok: true, ...data() }), '/example')).toEqual(data());
    expect(() =>
      parseRuntimeResult('{"ok":false,"error":{"code":"busy","message":"Busy"}}', '/example'),
    ).toThrow('Busy');
  });
  it.each(['{}', 'not json', '{"ok":true,"snapshot":null,"files":[]}'])(
    'rejects malformed output %s',
    (raw) => {
      expect(() => parseRuntimeResult(raw, '/example')).toThrow(ViewError);
    },
  );
  it('rejects a different root and a CDN URL masquerading as a local file', () => {
    expect(() => parseRuntimeResult(JSON.stringify({ ok: true, ...data() }), '/other')).toThrow();
    const bad = data();
    bad.files = [
      {
        id: 'https://cdn.example.test/a',
        relativePath: 'elsewhere',
        sha256: '',
        size: 1,
        kind: 'image',
      },
    ];
    expect(() => parseRuntimeResult(JSON.stringify({ ok: true, ...bad }), '/example')).toThrow();
  });
});
