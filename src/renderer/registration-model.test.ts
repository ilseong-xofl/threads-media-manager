import { expect, it } from 'vitest';
import type { Attachment, CaptionLanguage, Post } from '../shared/contracts';
import {
  addRegistrationMedia,
  captionGenerationInput,
  captionImageIds,
  moveRegistrationMedia,
  registrationChanged,
  registrationInput,
  registrationMedia,
  selectedRegistrationMedia,
  toggleRegistrationMedia,
} from './registration-model';

const imageId = 'a'.repeat(32);
const videoId = 'b'.repeat(32);
const editId = 'c'.repeat(32);
function media(mediaId: string, ordinal: number, extra: Partial<Attachment> = {}): Attachment {
  return {
    mediaId,
    ordinal,
    kind: 'image',
    status: 'saved',
    localUrl: `threads-media://file/${mediaId}`,
    observedAt: null,
    addressStatus: 'http_candidate',
    reason: null,
    ...extra,
  };
}
const post: Post = {
  key: 'sample:post',
  account: 'sample',
  postId: 'post',
  originalUrl: '',
  publishedAt: null,
  collectedAt: null,
  observedAt: null,
  caption: '  원문\n캡션  ',
  captionStatus: 'complete',
  captionObservedAt: null,
  attachmentStatus: 'partial',
  runStatus: 'complete',
  gapStatus: 'none',
  reasons: [],
  source: '',
  attachments: [media(imageId, 1), media(videoId, 2, { kind: 'video' })],
  edits: [media(editId, 3, { editType: 'capture', sourceMediaId: videoId })],
};

it.each<CaptionLanguage>(['en', 'ko', 'ja'])(
  'builds a %s generation request with selected images in order without changing the draft or source',
  (language) => {
    const ids = [editId, videoId, imageId];
    const before = structuredClone(post);
    const draft = registrationInput(post, '직접 작성한 캡션', ids, 4);
    const input = captionGenerationInput(post, ids, language, 4);
    expect(input).toEqual({ postKey: post.key, mediaIds: [editId, imageId], language });
    input.mediaIds.reverse();
    expect(ids).toEqual([editId, videoId, imageId]);
    expect(draft.caption).toBe('직접 작성한 캡션');
    expect(draft.mediaIds).toEqual(ids);
    expect(post).toEqual(before);
    expect(captionGenerationInput(post, ids, language, 4).mediaIds).toEqual([editId, imageId]);
  },
);

it('rejects empty, video-only, or partly unavailable selections before generation', () => {
  expect(() => captionGenerationInput(post, [], 'en', null)).toThrow('하나 이상');
  expect(() => captionGenerationInput(post, [videoId], 'ko', null)).toThrow('이미지');
  expect(() => captionGenerationInput(post, [imageId, 'd'.repeat(32)], 'ja', null)).toThrow(
    '사용할 수 없는 미디어',
  );
});

it('allows generation from an empty source caption and validates the requested language', () => {
  expect(captionGenerationInput({ ...post, caption: '' }, [imageId], 'en', null)).toEqual({
    postKey: post.key,
    mediaIds: [imageId],
    language: 'en',
  });
  expect(() => captionGenerationInput(post, [imageId], 'fr' as CaptionLanguage, null)).toThrow(
    '언어',
  );
});

it('disables AI input for empty or video-only selections even when other images exist', () => {
  expect(captionImageIds(post, [])).toEqual([]);
  expect(captionImageIds(post, [videoId])).toEqual([]);
});

it('sends only selected original and edited images in selected order, including captures', () => {
  const ids = [editId, videoId, imageId];
  const before = structuredClone(post);
  expect(captionImageIds(post, ids)).toEqual([editId, imageId]);
  expect(captionImageIds(post, [imageId])).toEqual([imageId]);
  expect(ids).toEqual([editId, videoId, imageId]);
  expect(post).toEqual(before);
  // The registered post itself still includes its selected video.
  expect(registrationInput(post, '', ids, null).mediaIds).toEqual(ids);
});

it('does not count missing or unavailable images as usable AI references', () => {
  const changed = { ...post, attachments: [media(imageId, 1, { status: 'review' })] };
  expect(captionImageIds(changed, [imageId, 'f'.repeat(32)])).toEqual([]);
  expect(captionImageIds(changed, [imageId, editId])).toEqual([editId]);
});

it('selects originals and edits only from this post, without duplicate IDs or source mutations', () => {
  const before = structuredClone(post);
  let selected = addRegistrationMedia(post, [], editId);
  selected = addRegistrationMedia(post, selected, imageId);
  expect(selected).toEqual([editId, imageId]);
  expect(addRegistrationMedia(post, selected, editId)).toEqual(selected);
  expect(addRegistrationMedia(post, selected, 'd'.repeat(32))).toEqual(selected);
  expect(registrationMedia(post)).toEqual([...post.attachments, ...post.edits!]);
  expect(post).toEqual(before);
});

it('toggles selected originals and edits while preserving the order of remaining media', () => {
  const ids = [editId, videoId, imageId];
  expect(toggleRegistrationMedia(post, ids, videoId)).toEqual([editId, imageId]);
  expect(toggleRegistrationMedia(post, ids, editId)).toEqual([videoId, imageId]);
  expect(toggleRegistrationMedia(post, [editId], imageId)).toEqual([editId, imageId]);
  expect(ids).toEqual([editId, videoId, imageId]);
});

it('allows removing a selected item at the selection limit or after its file becomes unavailable', () => {
  const full = [imageId, ...Array.from({ length: 99 }, (_, i) => i.toString(16).padStart(32, '0'))];
  expect(toggleRegistrationMedia(post, full, imageId)).toEqual(full.slice(1));
  expect(toggleRegistrationMedia(post, full, editId)).toEqual(full);
  const unavailable = { ...post, attachments: [media(imageId, 1, { status: 'review' })] };
  expect(toggleRegistrationMedia(unavailable, [imageId, editId], imageId)).toEqual([editId]);
  expect(toggleRegistrationMedia(unavailable, [], imageId)).toEqual([]);
});

it('keeps a missing saved selection in its original position until explicitly removed', () => {
  const missing = 'd'.repeat(32);
  const ids = [videoId, missing, editId];
  const selected = selectedRegistrationMedia(post, ids);
  expect(selected.map((entry) => entry.mediaId)).toEqual(ids);
  expect(selected[1].attachment).toBeUndefined();
  expect(() => registrationInput(post, 'edited', ids, 3)).toThrow('제거');
  expect(
    registrationInput(
      post,
      'edited',
      ids.filter((id) => id !== missing),
      3,
    ).mediaIds,
  ).toEqual([videoId, editId]);
});

it.each([
  { status: 'review' as const },
  { status: 'unavailable' as const },
  { localUrl: null },
  { localUrl: 'https://example.com/image.jpg' },
  { localUrl: `threads-media://file/${editId}` },
])('requires this media ID and a saved local file when selecting or saving (%o)', (extra) => {
  const unavailable: Post = { ...post, attachments: [media(imageId, 1, extra)] };
  expect(addRegistrationMedia(unavailable, [], imageId)).toEqual([]);
  expect(() => registrationInput(unavailable, '', [imageId], null)).toThrow('제거');
});

it('reorders by identity and preserves unrelated order, source arrays, and the selected caption', () => {
  const ids = [imageId, videoId, editId];
  const moved = moveRegistrationMedia(ids, editId, 0);
  expect(moved).toEqual([editId, imageId, videoId]);
  expect(moveRegistrationMedia(moved, editId, 2)).toEqual(ids);
  expect(moveRegistrationMedia(ids, imageId, 1)).toEqual([videoId, imageId, editId]);
  expect(ids).toEqual([imageId, videoId, editId]);
  expect(registrationInput(post, post.caption, moved, 8)).toEqual({
    postKey: post.key,
    caption: post.caption,
    mediaIds: moved,
    expectedRevision: 8,
  });
});

it('ignores stale drag identities and out-of-range keyboard positions', () => {
  const ids = [imageId, videoId, editId];
  for (const target of [-1, 3, NaN, 0.5])
    expect(moveRegistrationMedia(ids, videoId, target)).toEqual(ids);
  expect(moveRegistrationMedia(ids, 'outside-post', 0)).toEqual(ids);
  expect(moveRegistrationMedia([], imageId, 0)).toEqual([]);
});

it('builds a bounded ordered CAS input without trimming captions or sharing mutable IDs', () => {
  const ids = [editId, imageId];
  const input = registrationInput(post, '  문장\n\t끝  ', ids, null);
  expect(input).toEqual({
    postKey: post.key,
    caption: '  문장\n\t끝  ',
    mediaIds: ids,
    expectedRevision: null,
  });
  ids.reverse();
  expect(input.mediaIds).toEqual([editId, imageId]);
  expect(registrationInput(post, '', [videoId], 1).caption).toBe('');
  expect(registrationInput(post, '😀'.repeat(5000), [videoId], 2).caption.length).toBe(10000);
  expect(() => registrationInput(post, '😀'.repeat(5001), [videoId], 2)).toThrow('10,000');
  for (const caption of ['x\0y', 'x\u000by', 'x\u007fy'])
    expect(() => registrationInput(post, caption, [videoId], 2)).toThrow('문자');
});

it('refuses empty, duplicate, foreign, and oversized selections', () => {
  expect(() => registrationInput(post, '', [], null)).toThrow('하나 이상');
  expect(() => registrationInput(post, '', [imageId, imageId], null)).toThrow('중복');
  expect(() => registrationInput(post, '', ['d'.repeat(32)], null)).toThrow('제거');
  expect(() => registrationInput(post, '', Array(101).fill(imageId), null)).toThrow('100');
  const full = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(32, '0'));
  expect(addRegistrationMedia(post, full, editId)).toEqual(full);
});

it('never replaces a captured revision with an invalid or absent edit revision', () => {
  for (const revision of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => registrationInput(post, 'revision', [imageId], revision)).toThrow('다시 열고');
  expect(registrationInput(post, '', [imageId], 7).expectedRevision).toBe(7);
});

it('detects caption whitespace changes, additions, removals, and order changes for discard protection', () => {
  const baseline = { caption: '원문 ', mediaIds: [imageId, editId] };
  expect(registrationChanged(baseline, '원문 ', [...baseline.mediaIds])).toBe(false);
  expect(registrationChanged(baseline, '원문', baseline.mediaIds)).toBe(true);
  expect(registrationChanged(baseline, baseline.caption, [editId, imageId])).toBe(true);
  expect(registrationChanged(baseline, baseline.caption, [imageId])).toBe(true);
  expect(registrationChanged(baseline, baseline.caption, [...baseline.mediaIds, videoId])).toBe(
    true,
  );
});
