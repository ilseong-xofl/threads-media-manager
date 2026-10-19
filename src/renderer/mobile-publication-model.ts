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

export function mobilePublicationStatus(item: MobilePublication) {
  if (item.status === 'uploading') return '파일 전송 대기';
  if (item.status === 'ready') return '모바일 게시 대기';
  if (item.status === 'cancelled') return '회수·취소됨';
  if (item.status === 'expired') return '게시 기한 만료';
  if (item.status === 'published') return '원글 게시 완료';
  return ['unknown', 'uncertain'].includes(item.rootStatus)
    ? '게시 결과 확인 필요'
    : '휴대폰에서 게시 시작';
}

export function mobilePublicationCanRecall(item: MobilePublication) {
  return ['uploading', 'ready'].includes(item.status);
}
