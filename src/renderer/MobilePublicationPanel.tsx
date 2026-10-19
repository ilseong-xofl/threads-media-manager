import { useState } from 'react';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import type { MobilePublication } from '../shared/mobile-publications';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import { Icon } from './Icon';
import { displayDate } from './view-model';
import type { MobilePublicationsUi } from './use-mobile-publications';
import {
  mobileAccountChoices,
  mobilePublicationAccountLabel,
  mobilePublicationCanRecall,
  mobilePublicationStatus,
} from './mobile-publication-model';
import './managed-threads.css';
import './mobile-publications.css';

export function MobilePublicationPanel({
  mobile,
  accounts,
  disabled,
}: {
  mobile: MobilePublicationsUi;
  accounts: ManagedThreadsAccountRow[];
  disabled: boolean;
}) {
  const [recalling, setRecalling] = useState<MobilePublication | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const blocked = disabled || mobile.busy;
  return (
    <section
      className="registration-section mobile-publications"
      aria-labelledby="mobile-publications-title"
    >
      <h3 id="mobile-publications-title" className="section-divider">
        모바일 게시
      </h3>
      <div className="mobile-publications-heading">
        <p className="registration-hint">
          저장한 본문·댓글·미디어를 보내고, 휴대폰에서 확인 후 게시합니다.
        </p>
        <button type="button" disabled={blocked} onClick={() => void mobile.synchronize(true)}>
          <Icon name="refresh" /> 상태 확인
        </button>
      </div>
      {mobile.working && (
        <p className="mobile-publication-progress" role="status">
          <Icon name="refresh" className="is-spinning" />
          모바일 게시 정보를 처리하고 있습니다…
        </p>
      )}
      {!mobile.loaded && (
        <p className="registration-hint" role="status">
          {mobile.busy ? '전송 이력을 확인하고 있습니다.' : '상태 확인으로 전송 이력을 불러오세요.'}
        </p>
      )}
      {mobile.pending.map((item) => (
        <article className="mobile-publication-item" key={item.requestId}>
          <div>
            <strong>전송 확인 필요</strong>
            <span>{mobilePublicationAccountLabel(item.accountId, accounts)}</span>
          </div>
          <p>전송이 끝나지 않았습니다. 다시 시도하면 같은 전송을 이어서 확인합니다.</p>
          <button
            type="button"
            disabled={blocked}
            onClick={() => void mobile.retry(item.requestId)}
          >
            전송 재시도
          </button>
          <button type="button" disabled={blocked} onClick={() => setCancelling(item.requestId)}>
            전송 취소
          </button>
        </article>
      ))}
      {mobile.publications.map((item) => (
        <article className="mobile-publication-item" key={item.id}>
          <div>
            <strong>{mobilePublicationStatus(item)}</strong>
            <span>{mobilePublicationAccountLabel(item.accountId, accounts)}</span>
          </div>
          <p>
            등록본 {item.source.draftRevision} · 미디어 {item.media.length}개
            {item.comment ? ' · 댓글 포함' : ''}
          </p>
          {item.sentAt && <p>전송 {displayDate(item.sentAt)}</p>}
          {item.status === 'ready' && item.deadlineAt && (
            <p className="mobile-publication-deadline">게시 기한 {displayDate(item.deadlineAt)}</p>
          )}
          {mobilePublicationCanRecall(item) && (
            <button type="button" disabled={blocked} onClick={() => setRecalling(item)}>
              게시 대기 회수
            </button>
          )}
        </article>
      ))}
      {mobile.loaded && !mobile.pending.length && !mobile.publications.length && (
        <p className="registration-hint">아직 모바일로 보낸 게시본이 없습니다.</p>
      )}
      {recalling && (
        <ManagedThreadsActionDialog
          title="게시 대기를 회수할까요?"
          busy={mobile.working}
          onClose={() => setRecalling(null)}
          confirmation
        >
          <div className="mobile-publication-dialog-body">
            <p>
              <strong>{mobilePublicationAccountLabel(recalling.accountId, accounts)}</strong>의 게시
              대기에서 제외합니다.
            </p>
            <p>
              회수가 완료되면 로컬에서 내용을 수정하고 다시 보낼 수 있습니다. 휴대폰에서 이미 게시를
              시작했다면 회수할 수 없습니다.
            </p>
            <div className="mobile-publication-dialog-actions">
              <button type="button" disabled={mobile.working} onClick={() => setRecalling(null)}>
                취소
              </button>
              <button
                type="button"
                className="primary"
                disabled={mobile.working}
                onClick={() =>
                  void mobile
                    .recall({ publicationId: recalling.id, expectedVersion: recalling.version })
                    .then((ok) => {
                      if (ok) setRecalling(null);
                    })
                }
              >
                {mobile.working ? '회수 중…' : '회수'}
              </button>
            </div>
          </div>
        </ManagedThreadsActionDialog>
      )}
      {cancelling && (
        <ManagedThreadsActionDialog
          title="보류된 전송을 취소할까요?"
          busy={mobile.working}
          onClose={() => setCancelling(null)}
          confirmation
        >
          <div className="mobile-publication-dialog-body">
            <p>
              서버에 게시 대기가 만들어졌다면 함께 회수합니다. 로컬의 등록 글과 미디어는 유지됩니다.
            </p>
            <p>이미 휴대폰에서 게시를 시작한 경우에는 취소할 수 없습니다.</p>
            <div className="mobile-publication-dialog-actions">
              <button type="button" disabled={mobile.working} onClick={() => setCancelling(null)}>
                돌아가기
              </button>
              <button
                type="button"
                className="primary"
                disabled={mobile.working}
                onClick={() =>
                  void mobile.cancelPending(cancelling).then((ok) => {
                    if (ok) setCancelling(null);
                  })
                }
              >
                {mobile.working ? '취소 중…' : '전송 취소'}
              </button>
            </div>
          </div>
        </ManagedThreadsActionDialog>
      )}
    </section>
  );
}

export function MobilePublicationSendDialog({
  accounts,
  busy,
  mediaCount,
  includesComment,
  hasHistory,
  onSend,
  onClose,
}: {
  accounts: ManagedThreadsAccountRow[];
  busy: boolean;
  mediaCount: number;
  includesComment: boolean;
  hasHistory: boolean;
  onSend(accountId: string): Promise<boolean>;
  onClose(): void;
}) {
  const choices = mobileAccountChoices(accounts);
  const [accountId, setAccountId] = useState(() => choices[0]?.account?.id ?? '');
  const selectedAccountId = choices.some((item) => item.account?.id === accountId)
    ? accountId
    : (choices[0]?.account?.id ?? '');
  return (
    <ManagedThreadsActionDialog title="모바일로 보내기" busy={busy} onClose={onClose}>
      <div className="mobile-publication-dialog-body">
        <div className="mobile-publication-account-field">
          <label className="mobile-publication-account-label" htmlFor="mobile-publication-account">
            게시할 Threads 계정
          </label>
          <select
            id="mobile-publication-account"
            value={selectedAccountId}
            disabled={busy || !choices.length}
            onChange={(event) => setAccountId(event.target.value)}
          >
            {!choices.length && <option value="">등록된 계정이 없습니다</option>}
            {choices.map((item) => (
              <option key={item.account!.id} value={item.account!.id}>
                {mobilePublicationAccountLabel(item.account!.id, accounts)}
              </option>
            ))}
          </select>
        </div>
        {!choices.length && <p>계정 관리에서 계정을 등록하고 서버와 동기화해 주세요.</p>}
        <p>
          저장된 본문과 미디어 {mediaCount}개를 선택한 순서대로 보냅니다.
          {includesComment ? ' 준비한 댓글도 함께 보냅니다.' : ''}
        </p>
        <p>
          전송 완료 후 게시 기한은 7일입니다. 실제 원글과 댓글 게시는 해당 계정의 휴대폰에서 각각
          실행합니다.
        </p>
        {hasHistory && (
          <p className="mobile-publication-history-note">
            이 등록 글에는 이전 전송 또는 게시 이력이 있습니다. 새 게시본을 보내는지 대상 계정과
            내용을 확인해 주세요.
          </p>
        )}
        {busy && (
          <p role="status">
            미디어를 전송하고 모바일 게시 대기를 준비하고 있습니다. 완료될 때까지 기다려 주세요.
          </p>
        )}
        <div className="mobile-publication-dialog-actions">
          <button type="button" disabled={busy} onClick={onClose}>
            취소
          </button>
          <button
            type="button"
            className="primary"
            disabled={busy || !selectedAccountId}
            onClick={() =>
              void onSend(selectedAccountId).then((ok) => {
                if (ok) onClose();
              })
            }
          >
            {busy ? '전송 중…' : '선택한 계정으로 보내기'}
          </button>
        </div>
      </div>
    </ManagedThreadsActionDialog>
  );
}
