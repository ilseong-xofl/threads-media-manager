import type { Post } from './contracts';

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
