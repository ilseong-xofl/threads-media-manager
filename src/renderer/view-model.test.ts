import { expect, it } from 'vitest';
import type { Attachment, Post } from '../shared/contracts';
import {
  displayDate,
  filterPosts,
  isSavedPost,
  pendingPostCount,
  savedCount,
  postMedia,
  storageStatus,
} from './view-model';

const attachment = (
  status: Attachment['status'],
  overrides: Partial<Attachment> = {},
): Attachment => ({
  ordinal: 1,
  kind: 'image',
  addressStatus: 'http_candidate',
  observedAt: null,
  status,
  reason: null,
  mediaId: status === 'saved' ? 'a'.repeat(32) : null,
  localUrl: status === 'saved' ? `threads-media://file/${'a'.repeat(32)}` : null,
  ...overrides,
});
const post = (postId: string, account: string, attachments: Attachment[]): Post => ({
  key: `${account}:${postId}`,
  account,
  postId,
  originalUrl: '',
  publishedAt: null,
  collectedAt: null,
  observedAt: null,
  caption: '한글\n원문',
  captionStatus: 'complete',
  captionObservedAt: null,
  attachmentStatus: 'partial',
  runStatus: 'complete',
  gapStatus: 'none',
  reasons: ['attachment_count_unconfirmed'],
  source: '',
  attachments,
});

const complete = post('A', 'one', [attachment('saved'), attachment('saved', { ordinal: 2 })]);
const partial = post('B', 'one', [
  attachment('saved'),
  attachment('not_downloaded', { ordinal: 2 }),
]);
const pending = post('C', 'two', [attachment('not_downloaded')]);
const anotherComplete = post('D', 'two', [attachment('saved')]);
const posts = [complete, partial, pending, anotherComplete];

it('shows only fully saved posts while preserving account and full-caption search', () => {
  const before = structuredClone(posts);
  expect(filterPosts(posts, '', '')).toEqual([complete, anotherComplete]);
  expect(filterPosts(posts, 'one', '원문')).toEqual([complete]);
  expect(filterPosts(posts, 'two', ' d ')).toEqual([anotherComplete]);
  expect(filterPosts(posts, '', 'unknown')).toEqual([]);
  expect(posts).toEqual(before);
  expect(savedCount(partial)).toBe(1);
});

it('keeps the download count global when the saved gallery is filtered or empty', () => {
  expect(pendingPostCount(posts)).toBe(2);
  expect(filterPosts(posts, 'one', '')).toHaveLength(1);
  expect(pendingPostCount(posts)).toBe(2);
  expect(filterPosts(posts, 'missing-account', 'missing')).toEqual([]);
  expect(pendingPostCount(posts)).toBe(2);
  expect(pendingPostCount([])).toBe(0);
});

it('combines publication date, account, and caption search without changing the global pending count', () => {
  const matching = { ...complete, publishedAt: '2026-09-22T23:59:59+09:00', caption: '한글 원문' };
  const outside = {
    ...complete,
    key: 'one:old',
    postId: 'old',
    publishedAt: '2026-08-21T12:00:00+09:00',
  };
  const otherAccount = { ...anotherComplete, publishedAt: '2026-09-22T12:00:00+09:00' };
  const otherCaption = {
    ...complete,
    key: 'one:other',
    postId: 'other',
    publishedAt: matching.publishedAt,
    caption: '다른 내용',
  };
  const differentCollectedDate = { ...matching, collectedAt: '2027-01-01T12:00:00+09:00' };
  const candidates = [
    outside,
    differentCollectedDate,
    otherAccount,
    otherCaption,
    partial,
    pending,
  ];
  const before = structuredClone(candidates);
  const range = { from: '2026-08-22', to: '2026-09-22' };
  expect(filterPosts(candidates, 'one', ' 원문 ', range)).toEqual([differentCollectedDate]);
  expect(filterPosts(candidates, 'one', '원문', { from: '2026-10-01', to: '' })).toEqual([]);
  expect(pendingPostCount(candidates)).toBe(2);
  expect(candidates).toEqual(before);
});

it('retains the three-argument filter and includes unknown publication dates only for an open range', () => {
  expect(filterPosts(posts, '', '')).toEqual([complete, anotherComplete]);
  expect(filterPosts(posts, '', '', { from: '', to: '' })).toEqual([complete, anotherComplete]);
  expect(filterPosts(posts, '', '', { from: '2026-08-22', to: '2026-09-22' })).toEqual([]);
  expect(pendingPostCount(posts)).toBe(2);
});

it('does not treat empty, unavailable, or disconnected saved attachments as completed posts', () => {
  const incomplete = [
    post('empty', 'one', []),
    post('review', 'one', [attachment('review')]),
    post('unavailable', 'one', [attachment('unavailable')]),
    post('no-url', 'one', [attachment('saved', { localUrl: null })]),
    post('no-id', 'one', [attachment('saved', { mediaId: null })]),
  ];
  for (const item of incomplete) expect(isSavedPost(item)).toBe(false);
  expect(filterPosts(incomplete, '', '')).toEqual([]);
  expect(pendingPostCount(incomplete)).toBe(incomplete.length);
});

it('adds a post and decrements the pending count only after its final attachment is saved', () => {
  const updated = structuredClone(partial);
  expect(filterPosts([updated], '', '')).toEqual([]);
  expect(pendingPostCount([updated])).toBe(1);
  updated.attachments[1] = attachment('saved', { ordinal: 2 });
  expect(filterPosts([updated], '', '')).toEqual([updated]);
  expect(pendingPostCount([updated])).toBe(0);
  expect(updated.attachmentStatus).toBe('partial');
});

it('does not call unknown storage undownloaded and renders dates in KST', () => {
  expect(storageStatus(post('missing', 'one', [attachment('unavailable')]))).toBe('review');
  expect(displayDate(null)).toBe('미확인');
  expect(displayDate('2026-09-20T16:30:00Z')).toContain('21');
});

it('appends edits after originals without changing saved-gallery eligibility or pending counts', () => {
  const edited = {
    ...complete,
    edits: [
      attachment('saved', { ordinal: 3, editType: 'crop', mediaId: 'b'.repeat(32) }),
      attachment('review', { ordinal: 4, editType: 'capture', reason: 'invalid_file' }),
    ],
  };
  expect(postMedia(edited).map((item) => item.ordinal)).toEqual([1, 2, 3, 4]);
  expect(edited.attachments).toHaveLength(2);
  expect(savedCount(edited)).toBe(2);
  expect(isSavedPost(edited)).toBe(true);
  expect(filterPosts([edited, pending], '', '')).toEqual([edited]);
  expect(pendingPostCount([edited, pending])).toBe(1);
});

it('excludes skipped posts from pending downloads without hiding saved posts or mutating attachments', () => {
  const excludedPartial = { ...partial, downloadExcluded: true };
  const excludedPending = { ...pending, downloadExcluded: true };
  const saved = { ...complete, downloadExcluded: true };
  const newPost = post('new', 'two', [attachment('not_downloaded')]);
  const candidates = [excludedPartial, excludedPending, saved, newPost];
  const before = structuredClone(candidates);
  expect(pendingPostCount(candidates)).toBe(1);
  expect(pendingPostCount([excludedPartial, excludedPending, saved])).toBe(0);
  expect(filterPosts(candidates, '', '')).toEqual([saved]);
  expect(candidates).toEqual(before);
});
