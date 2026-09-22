import type { Post } from '../shared/contracts';
import { matchesDateRange, type DateRange } from './date-range';
export const postMedia = (post: Post) => [...post.attachments, ...(post.edits ?? [])];
export const isSavedPost = (post: Post) =>
  post.attachments.length > 0 &&
  post.attachments.every(
    (attachment) => attachment.status === 'saved' && !!attachment.localUrl && !!attachment.mediaId,
  );
export const pendingPostCount = (posts: Post[]) =>
  posts.filter((post) => !isSavedPost(post)).length;
export const savedCount = (post: Post) =>
  post.attachments.filter((a) => a.status === 'saved').length;
export function storageStatus(post: Post): string {
  if (post.attachments.some((a) => ['unavailable', 'review'].includes(a.status))) return 'review';
  const count = savedCount(post);
  return count === 0 ? 'none' : count === post.attachments.length ? 'saved' : 'partial';
}
export function filterPosts(
  posts: Post[],
  account: string,
  query: string,
  range?: DateRange,
): Post[] {
  const term = query.trim().toLocaleLowerCase();
  return posts.filter(
    (post) =>
      isSavedPost(post) &&
      (!account || post.account === account) &&
      (!range || matchesDateRange(post.publishedAt, range)) &&
      (!term ||
        `${post.account}\n${post.postId}\n${post.caption}`.toLocaleLowerCase().includes(term)),
  );
}
export function displayDate(value: string | null): string {
  if (!value) return '미확인';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '미확인';
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
export const completeness = (value: string) =>
  ({ complete: '확인 완료', partial: '일부 확인', unknown: '미확인' })[value] ?? value;
export const reasonLabel = (value: string) =>
  ({
    source_missing: '원본 연결 필요',
    edit_source_missing: '편집본의 원본 연결 확인 필요',
    invalid_edit: '편집본 정보 확인 필요',
    earlier_caption: '이전의 더 완전한 캡션을 표시합니다',
    earlier_attachments: '이전에 확인한 첨부 목록을 함께 표시합니다',
    attachment_source_missing: '저장된 첨부 중 원본 연결이 필요한 항목이 있습니다',
    published_date_conflict: '등록일 관찰 값이 서로 다릅니다',
    direct_url_required: '직접 다운로드 주소 미확인',
    media_kind_conflict: '첨부 종류 확인 필요',
    local_file_changed: '저장 파일 변경 확인 필요',
    invalid_file: '저장 파일을 찾을 수 없습니다',
    invalid_local_path: '저장 경로 확인 필요',
    local_file_unavailable: '저장 파일을 열 수 없습니다',
  })[value] ?? value;
