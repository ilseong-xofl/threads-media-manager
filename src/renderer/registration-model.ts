import type {
  Attachment,
  CaptionLanguage,
  GenerateCaptionInput,
  Post,
  PostDraft,
  SavePostDraftInput,
} from '../shared/contracts';

export const MAX_DRAFT_MEDIA = 100;
export const MAX_DRAFT_CAPTION = 10000;

export function registrationMedia(post: Post): Attachment[] {
  return [...post.attachments, ...(post.edits ?? []), ...(post.aiImages ?? [])];
}

export function registrationMediaLabel(item: Attachment): string {
  return item.aiGenerated ? 'AI 생성본' : item.editType ? '편집본' : '원본';
}

export function selectableMedia(item: Attachment): boolean {
  return (
    item.status === 'saved' &&
    !!item.mediaId &&
    /^[a-f0-9]{32}$/.test(item.mediaId) &&
    item.localUrl === `threads-media://file/${item.mediaId}`
  );
}

export function selectedRegistrationMedia(post: Post, mediaIds: readonly string[]) {
  const media = registrationMedia(post);
  return mediaIds.map((mediaId) => ({
    mediaId,
    attachment: media.find((item) => item.mediaId === mediaId),
  }));
}

export function captionImageIds(post: Post, mediaIds: readonly string[]): string[] {
  return selectedRegistrationMedia(post, mediaIds)
    .filter(({ attachment }) => attachment?.kind === 'image' && selectableMedia(attachment))
    .map(({ mediaId }) => mediaId);
}

export function captionGenerationInput(
  post: Post,
  mediaIds: readonly string[],
  language: CaptionLanguage,
  expectedRevision: number | null,
): GenerateCaptionInput {
  const input = registrationInput(post, '', mediaIds, expectedRevision);
  const images = captionImageIds(post, input.mediaIds);
  if (!images.length) throw new Error('AI 캡션을 만들려면 이미지를 하나 이상 선택하세요.');
  if (!['en', 'ko', 'ja'].includes(language)) throw new Error('AI 캡션 언어를 다시 선택하세요.');
  return { postKey: input.postKey, mediaIds: images, language };
}

export function addRegistrationMedia(
  post: Post,
  selected: readonly string[],
  mediaId: string,
): string[] {
  const item = registrationMedia(post).find((entry) => entry.mediaId === mediaId);
  if (!item || !selectableMedia(item) || selected.includes(mediaId)) return [...selected];
  if (selected.length >= MAX_DRAFT_MEDIA) return [...selected];
  return [...selected, mediaId];
}

export function toggleRegistrationMedia(
  post: Post,
  selected: readonly string[],
  mediaId: string,
): string[] {
  return selected.includes(mediaId)
    ? selected.filter((id) => id !== mediaId)
    : addRegistrationMedia(post, selected, mediaId);
}

export function moveRegistrationMedia(
  selected: readonly string[],
  mediaId: string,
  targetIndex: number,
): string[] {
  const from = selected.indexOf(mediaId);
  if (
    from < 0 ||
    !Number.isInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex >= selected.length
  )
    return [...selected];
  const next = [...selected];
  next.splice(from, 1);
  next.splice(targetIndex, 0, mediaId);
  return next;
}

export function registrationChanged(
  initial: Pick<PostDraft, 'caption' | 'mediaIds'>,
  caption: string,
  mediaIds: readonly string[],
): boolean {
  return (
    initial.caption !== caption ||
    initial.mediaIds.length !== mediaIds.length ||
    initial.mediaIds.some((id, index) => id !== mediaIds[index])
  );
}

export function registrationInput(
  post: Post,
  caption: string,
  mediaIds: readonly string[],
  expectedRevision: number | null,
): SavePostDraftInput {
  if (caption.length > MAX_DRAFT_CAPTION) throw new Error('캡션은 10,000자 이내로 입력하세요.');
  if (
    Array.from(caption).some((char) => {
      const code = char.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127;
    })
  )
    throw new Error('캡션에 사용할 수 없는 문자가 있습니다.');
  if (mediaIds.length === 0) throw new Error('등록할 미디어를 하나 이상 선택하세요.');
  if (mediaIds.length > MAX_DRAFT_MEDIA)
    throw new Error('미디어는 최대 100개까지 선택할 수 있습니다.');
  if (new Set(mediaIds).size !== mediaIds.length)
    throw new Error('같은 미디어를 중복 선택할 수 없습니다.');
  if (
    selectedRegistrationMedia(post, mediaIds).some(
      ({ attachment }) => !attachment || !selectableMedia(attachment),
    )
  )
    throw new Error('사용할 수 없는 미디어가 있습니다. 해당 항목을 선택 목록에서 제거하세요.');
  if (
    expectedRevision !== null &&
    (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
  )
    throw new Error('등록 정보를 다시 열고 저장하세요.');
  return { postKey: post.key, caption, mediaIds: [...mediaIds], expectedRevision };
}
