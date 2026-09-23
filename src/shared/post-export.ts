import type { Post, PostDraftActionInput } from './contracts';
import { validPostDraft } from './post-draft';

export function validPostDraftActionInput(value: unknown): value is PostDraftActionInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return (
    Object.keys(input).sort().join(',') === 'expectedRevision,postKey' &&
    typeof input.postKey === 'string' &&
    input.postKey.length > 0 &&
    input.postKey.length <= 512 &&
    typeof input.expectedRevision === 'number' &&
    Number.isSafeInteger(input.expectedRevision) &&
    input.expectedRevision > 0
  );
}

export function postDraftExportIssue(post: Post): string | null {
  if (!validPostDraft(post.draft)) return '등록 게시글을 찾을 수 없습니다. 목록을 새로고침하세요.';
  const media = new Map(
    [...post.attachments, ...(post.edits ?? []), ...(post.aiImages ?? [])].map((item) => [
      item.mediaId,
      item,
    ]),
  );
  if (
    post.draft.mediaIds.some((id) => {
      const item = media.get(id);
      return !item || item.status !== 'saved' || !item.localUrl;
    })
  )
    return '선택한 첨부를 찾을 수 없습니다. 등록 게시글을 수정한 뒤 다운로드하세요.';
  return null;
}

export function postExportIssue(post: Post): string | null {
  if (!post.attachments.length) return '저장할 첨부가 없습니다.';
  if (
    [...post.attachments, ...(post.edits ?? [])].some(
      (item) => item.status !== 'saved' || !item.mediaId || !item.localUrl,
    )
  )
    return '게시글의 첨부를 모두 저장한 뒤 ZIP으로 다운로드할 수 있습니다.';
  return null;
}
