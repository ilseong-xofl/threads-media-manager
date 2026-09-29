import { useEffect, useRef } from 'react';
import type { DownloadView } from '../shared/contracts';
import { Icon } from './Icon';
import { useToast } from './toast';

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

export function downloadOutcome(view: DownloadView, starting = false) {
  if (starting || activeDownload(view)) return null;
  const attention =
    !!view.problem ||
    view.recoverable ||
    view.resumable ||
    ['blocked', 'error'].includes(view.phase);
  if (!attention && view.phase !== 'complete' && !view.cleanedPosts && !view.releasedPosts)
    return null;
  const messages: string[] = [];
  if (attention) {
    messages.push(
      view.problem?.message ??
        (view.resumable || view.recoverable
          ? '다운로드 확인이 필요합니다.'
          : '다운로드가 중단되었습니다.'),
    );
  } else {
    messages.push(view.cleanedPosts || view.releasedPosts ? '처리 완료' : '다운로드 완료');
  }
  if (view.downloadedPosts !== undefined) {
    messages.push(
      `게시글 ${view.downloadedPosts}개 다운로드 · 중복 ${view.duplicatePostsRemoved ?? 0}개 제거`,
    );
  }
  if (view.batch && (attention || view.downloadedPosts === undefined)) {
    messages.push(
      `게시글 ${view.batch.completedPosts}/${view.batch.totalPosts} · 파일 ${view.batch.completedFiles}/${view.batch.totalFiles}`,
    );
  }
  if (view.cleanedPosts)
    messages.push(`수집이 불완전한 게시글 ${view.cleanedPosts}개를 삭제했습니다.`);
  if (view.releasedPosts)
    messages.push(`수집이 완료된 게시글 ${view.releasedPosts}개를 다운로드 대상으로 복원했습니다.`);
  if (view.batch?.skippedPosts)
    messages.push(
      `수집이 불완전한 게시글 ${view.batch.skippedPosts}개는 다운로드에서 제외했습니다.`,
    );
  if (view.batch && view.batch.deferredPosts > 0)
    messages.push(`보류된 게시글 ${view.batch.deferredPosts}개`);
  if (view.nextAllowedAt && view.phase === 'blocked')
    messages.push(`다음 다운로드 ${date(view.nextAllowedAt)} KST`);
  const message = messages.join('\n');
  return {
    message,
    error: !!attention,
    key: `download:${JSON.stringify([view.revision, view.phase, view.problem?.code, view.recoverable, view.resumable, message])}`,
  };
}

export function DownloadOverlay({ view, starting }: { view: DownloadView; starting: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const announced = useRef<string | null>(null);
  const notify = useToast();
  const active = activeDownload(view) || starting;
  const outcome = downloadOutcome(view, starting);
  // Polling returns new objects for the same result. Announce each outcome only once.
  useEffect(() => {
    if (active) {
      announced.current = null;
      return;
    }
    if (!outcome || announced.current === outcome.key) return;
    announced.current = outcome.key;
    notify(outcome);
  }, [active, outcome, notify]);
  useEffect(() => {
    const element = dialog.current;
    if (active && element && !element.open) element.showModal();
    if (!active && element?.open) element.close();
    return () => {
      if (element?.open) element.close();
    };
  }, [active]);
  if (!active) return null;
  const label = starting
    ? '다운로드 시작 중…'
    : {
        idle: '다운로드 확인 중…',
        checking: '다운로드 시작 중…',
        ready: '다운로드 준비 중…',
        downloading: '다운로드 중…',
        validating: '저장 파일 확인 중…',
        deduplicating: '중복 게시글 확인 중…',
        waiting: '다음 다운로드를 기다리는 중…',
        stopping: '다운로드를 중지하는 중…',
        recovering: '저장 파일 복구 중…',
        complete: '다운로드 완료',
        blocked: '다운로드 중단',
        error: '다운로드 중단',
      }[view.phase];
  const batch = view.batch;
  return (
    <dialog
      ref={dialog}
      className="download-overlay"
      aria-labelledby="download-status-title"
      onCancel={(event) => event.preventDefault()}
    >
      <section className="download-status-card">
        <Icon name="download" className="download-status-icon" />
        <div className="download-summary">
          <h2 id="download-status-title" role="status">
            {label}
          </h2>
          {batch ? (
            <p className="download-counts">
              게시글 {batch.completedPosts}/{batch.totalPosts} · 파일 {batch.completedFiles}/
              {batch.totalFiles}
              {batch.totalRounds > 0 && ` · ${batch.currentRound}/${batch.totalRounds}회차`}
            </p>
          ) : (
            <p>처리 중입니다.</p>
          )}
          {view.target && (
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
          {view.nextAllowedAt && view.phase === 'waiting' && (
            <p>다음 다운로드 {date(view.nextAllowedAt)} KST</p>
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
        </div>
      </section>
    </dialog>
  );
}
