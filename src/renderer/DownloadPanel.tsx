import { useEffect, useRef, useState } from 'react';
import type { DownloadView } from '../shared/contracts';
import { Icon } from './Icon';

const date = (time: number) =>
  new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(time * 1000);
const bytes = (n: number) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
export const activeDownload = (view: DownloadView) =>
  [
    'checking',
    'downloading',
    'validating',
    'deduplicating',
    'waiting',
    'stopping',
    'recovering',
  ].includes(view.phase);
export const idleDownload = (): DownloadView => ({
  phase: 'idle',
  target: null,
  nextAllowedAt: null,
  problem: null,
  recoverable: false,
  received: 0,
  total: null,
  revision: 0,
});

export function DownloadConfirmation({
  resuming,
  onCancel,
  onConfirm,
}: {
  resuming: boolean;
  onCancel(): void;
  onConfirm(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="download-confirmation"
      aria-labelledby="download-confirmation-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <h2 id="download-confirmation-title">
        {resuming ? '다운로드를 이어서 진행할까요?' : '다운로드를 시작할까요?'}
      </h2>
      <p>
        다운로드 중에는 게시글을 확인하거나 편집·작성할 수 없습니다. 저장 후 첫 이미지·영상의
        SHA-256이 같은 새 게시글은 전체 삭제합니다. 진행하시겠습니까?
      </p>
      <div className="download-confirmation-actions">
        <button type="button" onClick={onCancel}>
          취소
        </button>
        <button type="button" className="primary" onClick={onConfirm}>
          {resuming ? '이어서 다운로드' : '다운로드 시작'}
        </button>
      </div>
    </dialog>
  );
}

export function DownloadOverlay({
  view,
  starting,
  enabled,
  resume,
  recover,
}: {
  view: DownloadView;
  starting: boolean;
  enabled: boolean;
  resume(): void;
  recover(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [completeVisible, setCompleteVisible] = useState(true);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const active = activeDownload(view) || starting;
  const attention =
    !!view.problem || view.recoverable || view.resumable || view.phase === 'blocked';
  const complete = view.phase === 'complete' && !active && !attention;
  const dismissible = !active && (attention || view.phase === 'error' || complete);
  // Polling returns new objects. Remember the outcome, not the object identity,
  // so only a new download outcome can show a dismissed notice again.
  const noticeKey = JSON.stringify([
    view.revision,
    view.phase,
    view.problem?.code,
    view.problem?.message,
    view.recoverable,
    view.resumable,
  ]);
  useEffect(() => {
    if (active) setDismissedNotice(null);
  }, [active]);
  // A new result gets its own timer; polling and no-op inspections keep revision.
  useEffect(() => {
    setCompleteVisible(true);
    if (!complete) return;
    const timer = setTimeout(() => setCompleteVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [complete, view.revision]);
  const visible =
    (!dismissible || dismissedNotice !== noticeKey) &&
    (active ||
      attention ||
      view.phase === 'error' ||
      (view.phase === 'complete' && completeVisible));
  useEffect(() => {
    const element = dialog.current;
    if (visible && element && !element.open) element.showModal();
    if (!visible && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [visible]);
  if (!visible) return null;
  const label = starting
    ? '다운로드 시작 중…'
    : {
        idle: '다운로드 확인 필요',
        checking: '다운로드 시작 중…',
        ready: '다운로드 준비됨',
        downloading: '다운로드 중…',
        validating: '저장 파일 확인 중…',
        deduplicating: '중복 게시글 확인 중…',
        waiting: '다음 다운로드를 기다리는 중…',
        stopping: '다운로드를 중지하는 중…',
        recovering: '저장 파일 복구 중…',
        complete: attention
          ? '다운로드 확인 필요'
          : view.cleanedPosts || view.releasedPosts
            ? '처리 완료'
            : '다운로드 완료',
        blocked: view.problem?.code === 'posts_deferred' ? '다운로드 보류' : '다운로드 중단',
        error: '다운로드 중단',
      }[view.phase];
  const batch = view.batch;
  const dismiss = () => {
    if (!dismissible) return;
    if (complete) setCompleteVisible(false);
    else setDismissedNotice(noticeKey);
  };
  return (
    <dialog
      ref={dialog}
      className="download-overlay"
      aria-labelledby="download-status-title"
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
    >
      <section
        className={`download-status-card ${attention ? 'download-status-error' : complete ? 'download-status-complete' : ''} ${dismissible ? 'download-status-dismissible' : ''}`}
      >
        {dismissible && (
          <button
            type="button"
            className="download-status-close"
            aria-label="다운로드 상태 닫기"
            title="상태 닫기"
            onClick={dismiss}
          >
            <Icon name="close" />
          </button>
        )}
        <Icon name={complete ? 'check' : 'download'} className="download-status-icon" />
        <div className="download-summary">
          <h2 id="download-status-title" role="status">
            {label}
          </h2>
          {view.downloadedPosts !== undefined && (complete || !active) && (
            <p>
              게시글 {view.downloadedPosts}개 다운로드 · 중복 {view.duplicatePostsRemoved ?? 0}개
              제거
            </p>
          )}
          {!!view.cleanedPosts && (
            <p>수집이 불완전한 게시글 {view.cleanedPosts}개를 삭제했습니다.</p>
          )}
          {!!view.releasedPosts && (
            <p>수집이 완료된 게시글 {view.releasedPosts}개를 다운로드 대상으로 복원했습니다.</p>
          )}
          {!!batch?.skippedPosts && (
            <p>수집이 불완전한 게시글 {batch.skippedPosts}개는 다운로드에서 제외했습니다.</p>
          )}
          {!complete && (
            <>
              {batch ? (
                <p className="download-counts">
                  게시글 {batch.completedPosts}/{batch.totalPosts} · 파일 {batch.completedFiles}/
                  {batch.totalFiles}
                  {batch.totalRounds > 0 && ` · ${batch.currentRound}/${batch.totalRounds}회차`}
                </p>
              ) : (
                active && <p>처리 중입니다.</p>
              )}
              {view.target && active && (
                <p>
                  @{view.target.account} · {view.target.ordinal}번째{' '}
                  {view.target.kind === 'image' ? '이미지' : '영상'}
                </p>
              )}
              {view.phase === 'deduplicating' && view.total !== null && (
                <p>
                  중복 확인 {view.received}/{view.total}
                </p>
              )}
              {view.nextAllowedAt && ['waiting', 'blocked'].includes(view.phase) && (
                <p>다음 다운로드 {date(view.nextAllowedAt)} KST</p>
              )}
              {view.problem && (
                <p className="download-problem" role="alert">
                  {view.problem.message}
                </p>
              )}
              {batch && batch.deferredPosts > 0 && <p>보류된 게시글 {batch.deferredPosts}개</p>}
              {view.recoverable && !view.resumable && (
                <p>저장된 파일을 확인하고 중단된 다운로드를 복구할 수 있습니다.</p>
              )}
              {['downloading', 'validating', 'stopping'].includes(view.phase) && !starting && (
                <div className="download-progress">
                  <progress
                    aria-label="현재 파일 다운로드 진행"
                    value={view.total ? view.received : undefined}
                    max={view.total || 1}
                  />
                  <span>
                    {bytes(view.received)}
                    {view.total ? ` / ${bytes(view.total)}` : ''}
                  </span>
                </div>
              )}
            </>
          )}
        </div>
        {!active && (view.resumable || view.recoverable) && (
          <div className="download-actions">
            <button type="button" onClick={view.resumable ? resume : recover} disabled={!enabled}>
              {view.resumable ? '이어서 다운로드' : '로컬 저장 복구'}
            </button>
          </div>
        )}
      </section>
    </dialog>
  );
}
