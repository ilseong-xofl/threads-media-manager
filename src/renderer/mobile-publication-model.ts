import type { DailyPersona } from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import {
  lockedPublicationAccount,
  type MobilePublication,
  type PendingMobilePublication,
} from '../shared/mobile-publications';

export function mobileAccountChoices(rows: ManagedThreadsAccountRow[]) {
  return rows
    .filter((row) => row.account && !row.pendingDeletion)
    .sort((a, b) => Date.parse(a.account!.createdAt) - Date.parse(b.account!.createdAt));
}

export function mobilePublicationAccountLabel(accountId: string, rows: ManagedThreadsAccountRow[]) {
  const row = rows.find((item) => item.account?.id === accountId);
  return row ? `${row.appName} · @${row.label.replace(/^@/, '')}` : '이전에 연결한 계정';
}

/** Only history of this registration counts; a post deleted and registered again starts fresh. */
export function sameRegistrationHistory(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
  draftCreatedAt: string | null,
) {
  return {
    publications: publications.filter((item) => item.source.draftCreatedAt === draftCreatedAt),
    pending: pending.filter((item) => item.source.draftCreatedAt === draftCreatedAt),
  };
}

/**
 * The account a sent post is locked to, or null. The rule is the shared one the main process
 * also enforces: a pending send on this PC, a copy that is uploading, ready, started or published,
 * or a root that is `sending`, `unknown`, `uncertain` or `published` even when its copy was
 * cancelled (it may have reached Threads). An untouched root (`queued`) or a cleanly
 * `failed` one on a cancelled or expired copy locks nothing.
 */
export function mobilePublicationLocksAccount(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
  draftCreatedAt: string | null,
) {
  return draftCreatedAt === null
    ? null
    : lockedPublicationAccount(publications, pending, draftCreatedAt);
}

export interface PostAccountDecision {
  accountId: string | null;
  /** history: a locking send; note: recorded on this PC; auto: nobody chose it (자동 지정). */
  source: 'history' | 'note' | 'auto';
  locked: boolean;
}

/** Locking history, then this PC's record, then the first account that can send now. */
export function decidePostAccount(
  publications: MobilePublication[],
  pending: PendingMobilePublication[],
  draftCreatedAt: string | null,
  noteAccountId: string | null,
  rows: ManagedThreadsAccountRow[],
): PostAccountDecision {
  const locked = mobilePublicationLocksAccount(publications, pending, draftCreatedAt);
  if (locked !== null) return { accountId: locked, source: 'history', locked: true };
  if (noteAccountId !== null) return { accountId: noteAccountId, source: 'note', locked: false };
  const choices = mobileAccountChoices(rows);
  const first = choices.find((row) => !row.pendingAction) ?? choices[0];
  return { accountId: first?.account?.id ?? null, source: 'auto', locked: false };
}

export function accountPersona(accountId: string | null, personas: DailyPersona[]) {
  return accountId === null
    ? undefined
    : personas.find((persona) => persona.accountId === accountId);
}

/** `앱 · @계정` plus ` — 페르소나` when the account has one. */
export function postAccountOptionLabel(row: ManagedThreadsAccountRow, personas: DailyPersona[]) {
  const persona = accountPersona(row.account?.id ?? null, personas);
  const name = `${row.appName} · @${row.label.replace(/^@/, '')}`;
  return persona ? `${name} — ${persona.name}` : name;
}

/** Why the post cannot be saved for this account, or null. Writing allows a pending refresh. */
export function postAccountSaveProblem(accountId: string | null, rows: ManagedThreadsAccountRow[]) {
  if (accountId === null) return '이 글을 올릴 계정을 고르세요.';
  if (!mobileAccountChoices(rows).some((row) => row.account?.id === accountId))
    return '저장된 계정을 찾지 못했습니다. 다른 계정을 고르세요.';
  return null;
}

/** Why the post cannot be sent to its account now, or null when it can. */
export function mobileSendAccountProblem(
  accountId: string | null,
  rows: ManagedThreadsAccountRow[],
) {
  const row = accountId === null ? undefined : rows.find((item) => item.account?.id === accountId);
  if (!row) return '보낼 계정을 찾지 못했습니다. 수정에서 계정을 확인하세요.';
  if (row.pendingDeletion) return '이 계정은 삭제하고 있어 보낼 수 없습니다.';
  if (row.pendingAction) return '이 계정은 계정 관리에서 [갱신 재시도]를 마친 뒤 보낼 수 있습니다.';
  return null;
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
