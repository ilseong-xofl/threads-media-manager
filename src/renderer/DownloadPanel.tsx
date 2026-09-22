import { useEffect, useState } from 'react';
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
  ['checking', 'downloading', 'validating', 'waiting', 'stopping', 'recovering'].includes(
    view.phase,
  );
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

export function DownloadToast({
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
  const [completeVisible, setCompleteVisible] = useState(true);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  const active = activeDownload(view) || starting;
  const attention =
    !!view.problem || view.recoverable || view.resumable || view.phase === 'blocked';
  const complete = view.phase === 'complete' && !active && !attention;
  const dismissible = !active && (attention || view.phase === 'error');
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
  // Polling updates revision frequently; only entering complete starts the timer.
  useEffect(() => {
    setCompleteVisible(true);
    if (!complete) return;
    const timer = setTimeout(() => setCompleteVisible(false), 3000);
    return () => clearTimeout(timer);
  }, [complete]);
  if (dismissible && dismissedNotice === noticeKey) return null;
  if (
    !active &&
    !attention &&
    (view.phase === 'idle' ||
      view.phase === 'ready' ||
      (view.phase === 'complete' && !completeVisible))
  )
    return null;
  const label = starting
    ? '다운로드 시작 중…'
    : {
        idle: '다운로드 확인 필요',
        checking: '다운로드 시작 중…',
        ready: '다운로드 준비됨',
        downloading: '다운로드 중…',
        validating: '저장 파일 확인 중…',
        waiting: '다음 다운로드를 기다리는 중…',
        stopping: '다운로드를 중지하는 중…',
        recovering: '로컬 저장 복구 중…',
        complete: attention ? '다운로드 확인 필요' : '다운로드 완료',
        blocked: view.problem?.code === 'posts_deferred' ? '다운로드 보류' : '다운로드 중단',
        error: '다운로드 중단',
      }[view.phase];
  const batch = view.batch;
  return (
    <section
      className={`download-toast ${attention ? 'download-toast-error' : complete ? 'download-toast-complete' : ''} ${dismissible ? 'download-toast-dismissible' : ''}`}
      aria-label="다운로드 상태"
    >
      {dismissible && (
        <button
          type="button"
          className="download-toast-close"
          aria-label="다운로드 안내 닫기"
          title="안내 닫기"
          onClick={() => setDismissedNotice(noticeKey)}
        >
          <Icon name="close" />
        </button>
      )}
      <Icon name={complete ? 'check' : 'download'} className="download-toast-icon" />
      <div className="download-summary">
        <strong role="status">{label}</strong>
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
              <p>이미 받은 파일만 확인해 복구합니다. 다운로드를 다시 시도하지 않습니다.</p>
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
          <button onClick={view.resumable ? resume : recover} disabled={!enabled}>
            {view.resumable ? '이어서 다운로드' : '파일 상태 확인'}
          </button>
        </div>
      )}
    </section>
  );
}
