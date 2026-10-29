import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import type { MobilePublication, PendingMobilePublication } from '../shared/mobile-publications';

export function mobileAccountChoices(rows: ManagedThreadsAccountRow[]) {
  return rows
    .filter((row) => row.account && !row.pendingDeletion)
    .sort((a, b) => Date.parse(a.account!.createdAt) - Date.parse(b.account!.createdAt));
}

export function mobilePublicationAccountLabel(accountId: string, rows: ManagedThreadsAccountRow[]) {
  const row = rows.find((item) => item.account?.id === accountId);
  return row ? `${row.appName} · @${row.label.replace(/^@/, '')}` : '이전에 연결한 계정';
}

export function mobilePublicationLocksEditing(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
) {
  return (
    pending.length > 0 || publications.some((item) => ['uploading', 'ready'].includes(item.status))
  );
}

/** A sent copy's reply follows the PC until the phone starts posting it. */
export function mobilePublicationLocksComment(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
) {
  if (pending.length > 0 || publications.some((item) => item.status === 'uploading')) return true;
  const sent = publications.find((item) => ['ready', 'started', 'published'].includes(item.status));
  return !!sent && ['sending', 'unknown', 'published'].includes(sent.commentStatus);
}

export function mobilePublicationStatus(item: MobilePublication) {
  if (item.status === 'uploading') return '파일 전송 대기';
  if (item.status === 'ready') return '모바일 게시 대기';
  if (item.status === 'cancelled') {
    if (
      ['sending', 'unknown', 'uncertain'].includes(item.rootStatus) ||
      ['sending', 'unknown', 'uncertain'].includes(item.commentStatus)
    )
      return '등록 작업 삭제됨 · 원격 결과 미확인';
    if (item.rootStatus === 'published') return '등록 작업 삭제됨 · 원글 완료 이력 보존';
    if (item.rootStatus === 'failed') return '등록 작업 삭제됨';
    return '회수·취소됨';
  }
  if (item.status === 'expired') return '게시 기한 만료';
  if (item.status === 'published') return '원글 게시 완료';
  // Since 2026-10-29 the phone records no start, so a started post failed or got no answer.
  return '모바일 게시 오류';
}

export function mobilePublicationCanRecall(item: MobilePublication) {
  return ['uploading', 'ready'].includes(item.status);
}

export function mobilePublicationCanAbandon(item: MobilePublication) {
  return (
    item.status === 'started' ||
    (item.status === 'published' &&
      ['queued', 'sending', 'unknown', 'failed'].includes(item.commentStatus))
  );
}
