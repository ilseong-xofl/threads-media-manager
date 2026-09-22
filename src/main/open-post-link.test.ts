import { describe, expect, it, vi } from 'vitest';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, type CollectionView, type Post, type ThreadsMediaApi } from '../shared/contracts';
import { openPostLink } from './open-post-link';
import '../preload';

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn() },
}));

const postKey = 'demo:PostA';
const originalUrl = 'HTTPS://Example.test:443/original?q=one%20two&part=%2f#section';
const commentUrl = 'http://comment.test/path?source=demo#reply';
function view(): CollectionView {
  const post: Post = {
    key: postKey,
    account: 'demo',
    postId: 'PostA',
    originalUrl,
    caption: '',
    publishedAt: null,
    collectedAt: null,
    observedAt: null,
    captionObservedAt: null,
    captionStatus: 'complete',
    attachmentStatus: 'complete',
    runStatus: 'complete',
    gapStatus: 'none',
    reasons: [],
    source: 'synthetic.xlsx',
    attachments: [],
    comment: { caption: 'Local comment', link: commentUrl, updatedAt: '2026-09-22T10:00:00Z' },
  };
  return {
    snapshot: {
      root: '/synthetic',
      loadedAt: '2026-09-22',
      sourceCount: 1,
      posts: [post],
      warnings: [],
      stateStatus: 'read_only',
    },
    error: null,
  };
}

describe('opening registered post links', () => {
  it.each(['original', 'comment'] as const)(
    'opens the exact registered %s URL and ignores a URL supplied by the renderer',
    async (kind) => {
      const open = vi.fn().mockResolvedValue(undefined);
      const current = view();
      const before = structuredClone(current);
      expect(
        await openPostLink(
          current,
          { postKey, kind, url: 'https://unregistered.test', path: '/outside' },
          open,
        ),
      ).toEqual({ status: 'opened' });
      expect(open).toHaveBeenCalledExactlyOnceWith(kind === 'original' ? originalUrl : commentUrl);
      expect(current).toEqual(before);
    },
  );
  it('can open a displayed registered link while the last refresh has an error', async () => {
    const current = view();
    current.error = { code: 'busy', message: 'Other work is running.' };
    const open = vi.fn().mockResolvedValue(undefined);
    expect(await openPostLink(current, { postKey, kind: 'original' }, open)).toEqual({
      status: 'opened',
    });
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { postKey, kind: 'file' },
    { postKey: '', kind: 'original' },
    { postKey: 'a'.repeat(513), kind: 'original' },
    { postKey: 123, kind: 'comment' },
  ])('rejects malformed arguments without opening anything', async (input) => {
    const open = vi.fn();
    expect(await openPostLink(view(), input, open)).toMatchObject({
      status: 'error',
      problem: { code: 'link_input' },
    });
    expect(open).not.toHaveBeenCalled();
  });
  it.each([true, false])('rejects a missing post when snapshot exists=%s', async (hasSnapshot) => {
    const current = view();
    if (!hasSnapshot) current.snapshot = null;
    const open = vi.fn();
    expect(
      await openPostLink(current, { postKey: 'other:PostB', kind: 'original' }, open),
    ).toMatchObject({ status: 'error', problem: { code: 'link_post_missing' } });
    expect(open).not.toHaveBeenCalled();
  });
  it.each([
    '',
    'javascript:alert(1)',
    'file:///private/file',
    'threads-media://file/abc',
    'mailto:user@example.test',
    'example.test/path',
    '//example.test/path',
    'https:example.test',
    'https:///example.test',
    'https://',
    'https://user:secret@example.test',
    'https://user@example.test',
    'https://@example.test',
    'https://example.test/one two',
    'https://example.test/\npath',
    'https://example.test/\u0000path',
    'https://example.test/\u007fpath',
    'https://example.test\\file',
    'https://example.test:invalid',
    'https://example.test/' + 'a'.repeat(4096),
  ])('rejects an unsafe or invalid registered address', async (url) => {
    const current = view();
    current.snapshot!.posts[0].originalUrl = url;
    const open = vi.fn();
    expect(await openPostLink(current, { postKey, kind: 'original' }, open)).toMatchObject({
      status: 'error',
      problem: { code: 'link_invalid' },
    });
    expect(open).not.toHaveBeenCalled();
  });
  it('allows an address exactly at the 4096-character limit', async () => {
    const current = view();
    const prefix = 'https://example.test/';
    const url = prefix + 'a'.repeat(4096 - prefix.length);
    current.snapshot!.posts[0].originalUrl = url;
    const open = vi.fn().mockResolvedValue(undefined);
    expect((await openPostLink(current, { postKey, kind: 'original' }, open)).status).toBe(
      'opened',
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(url);
  });
  it('rejects a missing or invalid comment link without falling back to the original', async () => {
    const current = view();
    const open = vi.fn();
    delete current.snapshot!.posts[0].comment;
    expect((await openPostLink(current, { postKey, kind: 'comment' }, open)).status).toBe('error');
    current.snapshot!.posts[0].comment = {
      caption: '',
      link: 'file:///private/file',
      updatedAt: '2026-09-22T10:00:00Z',
    };
    expect((await openPostLink(current, { postKey, kind: 'comment' }, open)).status).toBe('error');
    expect(open).not.toHaveBeenCalled();
  });
  it('surfaces browser-opening failures without exposing the URL or internal error', async () => {
    const open = vi.fn().mockRejectedValue(new Error('secret browser path'));
    const result = await openPostLink(view(), { postKey, kind: 'original' }, open);
    expect(result).toMatchObject({ status: 'error', problem: { code: 'link_open_failed' } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain(originalUrl);
  });
  it('registers the preload method on its own IPC channel with only the identity payload', async () => {
    const registration = vi
      .mocked(contextBridge.exposeInMainWorld)
      .mock.calls.find(([name]) => name === 'threadsMedia');
    const api = registration?.[1] as ThreadsMediaApi;
    expect(Object.isFrozen(api)).toBe(true);
    vi.mocked(ipcRenderer.invoke).mockResolvedValueOnce({ status: 'opened' });
    const input = { postKey, kind: 'comment' as const };
    expect(await api.openPostLink(input)).toEqual({ status: 'opened' });
    expect(ipcRenderer.invoke).toHaveBeenCalledExactlyOnceWith(IPC.openPostLink, input);
  });
});
