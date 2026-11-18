import { expect, it } from 'vitest';
import type { Attachment, CaptionLanguage, Post } from '../shared/contracts';
import {
  addRegistrationMedia,
  captionGenerationInput,
  captionImageIds,
  captionSuggestionContext,
  moveRegistrationMedia,
  registrationChanged,
  registrationInput,
  registrationMedia,
  registrationMediaLabel,
  savedTranslation,
  selectedRegistrationMedia,
  toggleRegistrationMedia,
  rememberTranslations,
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
    const draft = registrationInput(post, '직접 작성한 캡션', ids, 4, 'account-one', null);
    const input = captionGenerationInput(post, ids, language, 4, null);
    expect(input).toEqual({ postKey: post.key, mediaIds: [editId, imageId], language });
    input.mediaIds.reverse();
    expect(ids).toEqual([editId, videoId, imageId]);
    expect(draft.caption).toBe('직접 작성한 캡션');
    expect(draft.mediaIds).toEqual(ids);
    expect(post).toEqual(before);
    expect(captionGenerationInput(post, ids, language, 4, null).mediaIds).toEqual([
      editId,
      imageId,
    ]);
  },
);

it('rejects empty or partly unavailable selections before generation and lets videos through', () => {
  expect(() => captionGenerationInput(post, [], 'en', null, null)).toThrow('하나 이상');
  // Videos only: main sends a still of the first one, or the source caption alone.
  expect(captionGenerationInput(post, [videoId], 'ko', null, null)).toEqual({
    postKey: post.key,
    mediaIds: [videoId],
    language: 'ko',
  });
  expect(() => captionGenerationInput(post, [imageId, 'd'.repeat(32)], 'ja', null, null)).toThrow(
    '사용할 수 없는 미디어',
  );
});

it('allows generation from an empty source caption and validates the requested language', () => {
  expect(captionGenerationInput({ ...post, caption: '' }, [imageId], 'en', null, null)).toEqual({
    postKey: post.key,
    mediaIds: [imageId],
    language: 'en',
  });
  expect(() =>
    captionGenerationInput(post, [imageId], 'fr' as CaptionLanguage, null, null),
  ).toThrow('언어');
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
  expect(registrationInput(post, '', ids, null, 'account-one', null).mediaIds).toEqual(ids);
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
  expect(() => registrationInput(post, 'edited', ids, 3, 'account-one', null)).toThrow('제거');
  expect(
    registrationInput(
      post,
      'edited',
      ids.filter((id) => id !== missing),
      3,
      'account-one',
      null,
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
  expect(() => registrationInput(unavailable, '', [imageId], null, 'account-one', null)).toThrow(
    '제거',
  );
});

it('reorders by identity and preserves unrelated order, source arrays, and the selected caption', () => {
  const ids = [imageId, videoId, editId];
  const moved = moveRegistrationMedia(ids, editId, 0);
  expect(moved).toEqual([editId, imageId, videoId]);
  expect(moveRegistrationMedia(moved, editId, 2)).toEqual(ids);
  expect(moveRegistrationMedia(ids, imageId, 1)).toEqual([videoId, imageId, editId]);
  expect(ids).toEqual([imageId, videoId, editId]);
  expect(registrationInput(post, post.caption, moved, 8, 'account-one', null)).toEqual({
    postKey: post.key,
    caption: post.caption,
    mediaIds: moved,
    expectedRevision: 8,
    accountId: 'account-one',
    translation: null,
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
  const input = registrationInput(post, '  문장\n\t끝  ', ids, null, 'account-one', null);
  expect(input).toEqual({
    postKey: post.key,
    caption: '  문장\n\t끝  ',
    mediaIds: ids,
    expectedRevision: null,
    accountId: 'account-one',
    translation: null,
  });
  ids.reverse();
  expect(input.mediaIds).toEqual([editId, imageId]);
  expect(registrationInput(post, '', [videoId], 1, 'account-one', null).caption).toBe('');
  expect(
    registrationInput(post, '😀'.repeat(5000), [videoId], 2, 'account-one', null).caption.length,
  ).toBe(10000);
  expect(() =>
    registrationInput(post, '😀'.repeat(5001), [videoId], 2, 'account-one', null),
  ).toThrow('10,000');
  for (const caption of ['x\0y', 'x\u000by', 'x\u007fy'])
    expect(() => registrationInput(post, caption, [videoId], 2, 'account-one', null)).toThrow(
      '문자',
    );
});

it('refuses empty, duplicate, foreign, and oversized selections', () => {
  expect(() => registrationInput(post, '', [], null, 'account-one', null)).toThrow('하나 이상');
  expect(() => registrationInput(post, '', [imageId, imageId], null, 'account-one', null)).toThrow(
    '중복',
  );
  expect(() => registrationInput(post, '', ['d'.repeat(32)], null, 'account-one', null)).toThrow(
    '제거',
  );
  expect(() =>
    registrationInput(post, '', Array(101).fill(imageId), null, 'account-one', null),
  ).toThrow('100');
  const full = Array.from({ length: 100 }, (_, index) => index.toString(16).padStart(32, '0'));
  expect(addRegistrationMedia(post, full, editId)).toEqual(full);
});

it('never replaces a captured revision with an invalid or absent edit revision', () => {
  for (const revision of [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() =>
      registrationInput(post, 'revision', [imageId], revision, 'account-one', null),
    ).toThrow('다시 열고');
  expect(registrationInput(post, '', [imageId], 7, 'account-one', null).expectedRevision).toBe(7);
});

it('detects caption whitespace changes, additions, removals, and order changes for discard protection', () => {
  const baseline = { caption: '원문 ', mediaIds: [imageId, editId], accountId: 'account-one' };
  const same = 'account-one';
  expect(registrationChanged(baseline, '원문 ', [...baseline.mediaIds], same)).toBe(false);
  expect(registrationChanged(baseline, '원문', baseline.mediaIds, same)).toBe(true);
  expect(registrationChanged(baseline, baseline.caption, [editId, imageId], same)).toBe(true);
  expect(registrationChanged(baseline, baseline.caption, [imageId], same)).toBe(true);
  expect(
    registrationChanged(baseline, baseline.caption, [...baseline.mediaIds, videoId], same),
  ).toBe(true);
});

it('counts a change of only the account as a change to save', () => {
  const baseline = { caption: '원문', mediaIds: [imageId], accountId: 'account-one' };
  expect(registrationChanged(baseline, '원문', [imageId], 'account-two')).toBe(true);
  expect(registrationChanged(baseline, '원문', [imageId], null)).toBe(true);
  expect(registrationChanged({ ...baseline, accountId: null }, '원문', [imageId], null)).toBe(
    false,
  );
});

it('carries the account into the generation and save inputs without validating it there', () => {
  expect(captionGenerationInput(post, [imageId], 'ja', null, 'account-two')).toEqual({
    postKey: post.key,
    mediaIds: [imageId],
    language: 'ja',
    accountId: 'account-two',
  });
  expect(captionGenerationInput(post, [imageId], 'ja', null, null)).not.toHaveProperty('accountId');
  expect(registrationInput(post, '캡션', [imageId], 2, 'account-two', '뜻')).toMatchObject({
    accountId: 'account-two',
    translation: '뜻',
  });
});

it('keeps the Korean of the chosen suggestion, else the stored one while the text is unchanged', () => {
  const suggestions = { texts: ['one', 'two', 'three'], translations: ['하나', '둘', '셋'] };
  const saved = { text: 'saved', translation: '저장된 뜻' };
  expect(savedTranslation('two', suggestions, saved)).toBe('둘');
  expect(savedTranslation('saved', suggestions, saved)).toBe('저장된 뜻');
  expect(savedTranslation('two ', suggestions, saved)).toBeNull();
  expect(savedTranslation('edited', suggestions, saved)).toBeNull();
  expect(savedTranslation('saved', null, saved)).toBe('저장된 뜻');
  expect(savedTranslation('saved', null, null)).toBeNull();
  // A suggestion without a rendering (no persona) falls back to the stored one only when unchanged.
  expect(savedTranslation('two', { texts: suggestions.texts }, saved)).toBeNull();
  expect(savedTranslation('saved', { texts: ['saved', 'b', 'c'] }, saved)).toBe('저장된 뜻');
});

it('ties caption suggestions to the account and the persona they were written for', () => {
  const persona = {
    id: 'persona-one',
    name: '하루',
    accountId: 'account-one',
    language: 'en' as const,
    description: '직업: 간호사',
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  const base = captionSuggestionContext('account-one', persona);
  expect(captionSuggestionContext('account-one', { ...persona })).toBe(base);
  expect(captionSuggestionContext('account-two', persona)).not.toBe(base);
  expect(captionSuggestionContext('account-one', { ...persona, language: 'ja' })).not.toBe(base);
  expect(
    captionSuggestionContext('account-one', { ...persona, description: '직업: 교사' }),
  ).not.toBe(base);
  expect(captionSuggestionContext('account-one', { ...persona, id: 'persona-two' })).not.toBe(base);
  expect(captionSuggestionContext('account-one')).not.toBe(base);
});

it('lists originals, edits, and all AI generation versions in order and labels them separately', () => {
  const aiFirst = media('d'.repeat(32), 4, {
    aiGenerated: true,
    generationId: '1'.repeat(32),
  });
  const aiSecond = media('e'.repeat(32), 5, {
    aiGenerated: true,
    generationId: '2'.repeat(32),
  });
  const withAI = { ...post, aiImages: [aiFirst, aiSecond] };
  const before = structuredClone(withAI);
  const available = registrationMedia(withAI);
  expect(available.map((item) => item.mediaId)).toEqual([
    imageId,
    videoId,
    editId,
    aiFirst.mediaId,
    aiSecond.mediaId,
  ]);
  expect(available.map(registrationMediaLabel)).toEqual([
    '원본',
    '원본',
    '편집본',
    'AI 생성본',
    'AI 생성본',
  ]);
  available.reverse();
  expect(withAI).toEqual(before);
});

it('selects and reorders mixed AI, edited and original media without changing the typed caption', () => {
  const aiId = 'd'.repeat(32);
  const withAI = { ...post, aiImages: [media(aiId, 4, { aiGenerated: true })] };
  let selected = addRegistrationMedia(withAI, [], imageId);
  selected = addRegistrationMedia(withAI, selected, aiId);
  selected = addRegistrationMedia(withAI, selected, editId);
  expect(addRegistrationMedia(withAI, selected, aiId)).toEqual(selected);
  selected = moveRegistrationMedia(selected, aiId, 0);
  expect(selected).toEqual([aiId, imageId, editId]);
  expect(
    selectedRegistrationMedia(withAI, selected).map((item) => item.attachment?.mediaId),
  ).toEqual(selected);
  expect(registrationInput(withAI, '직접 작성한 캡션', selected, 5, 'account-one', null)).toEqual({
    postKey: post.key,
    caption: '직접 작성한 캡션',
    mediaIds: selected,
    expectedRevision: 5,
    accountId: 'account-one',
    translation: null,
  });
  expect(captionGenerationInput(withAI, selected, 'ko', 5, null).mediaIds).toEqual(selected);
  expect(toggleRegistrationMedia(withAI, selected, aiId)).toEqual([imageId, editId]);
  expect(registrationInput(withAI, '', [aiId], null, 'account-one', null).mediaIds).toEqual([aiId]);
});

it('keeps an unavailable AI selection visible but requires explicit removal before saving', () => {
  const aiId = 'd'.repeat(32);
  const unavailable = {
    ...post,
    aiImages: [media(aiId, 4, { aiGenerated: true, status: 'unavailable', localUrl: null })],
  };
  expect(addRegistrationMedia(unavailable, [], aiId)).toEqual([]);
  const selected = [imageId, aiId, editId];
  expect(selectedRegistrationMedia(unavailable, selected)[1].attachment?.aiGenerated).toBe(true);
  expect(() =>
    registrationInput(unavailable, '캡션 유지', selected, 3, 'account-one', null),
  ).toThrow('제거');
  expect(captionImageIds(unavailable, selected)).toEqual([imageId, editId]);
  expect(toggleRegistrationMedia(unavailable, selected, aiId)).toEqual([imageId, editId]);
  // A production response with no AI candidates must not silently drop a saved AI selection.
  expect(selectedRegistrationMedia(post, selected)[1].attachment).toBeUndefined();
  expect(() => registrationInput(post, '캡션 유지', selected, 3, 'account-one', null)).toThrow(
    '제거',
  );
});

it('keeps the Korean of a suggestion taken as the text after the list is replaced', () => {
  const seen = new Map<string, string>();
  rememberTranslations(seen, ['First', 'Second', 'Third'], ['첫째', '둘째', '셋째']);
  rememberTranslations(seen, ['Plain one', 'Plain two', 'Plain three'], undefined);
  const regenerated = {
    texts: ['Fourth', 'Fifth', 'Sixth'],
    translations: ['넷', '다섯', '여섯'],
  };
  // The list on screen no longer has the chosen text, and nothing was saved yet.
  expect(savedTranslation('Second', regenerated, null, seen)).toBe('둘째');
  expect(savedTranslation('Second', null, null, seen)).toBe('둘째');
  expect(savedTranslation('Second', regenerated, null)).toBeNull();
  // A text typed by hand, or one that never had a rendering, still has none.
  expect(savedTranslation('Second, edited', regenerated, null, seen)).toBeNull();
  expect(savedTranslation('Plain one', regenerated, null, seen)).toBeNull();
});
