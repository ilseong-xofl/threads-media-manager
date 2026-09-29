import { useEffect, useRef } from 'react';
import type { ThreadsPublishProgress } from '../shared/threads-api';
import './threads-api.css';

export function threadsUploadLabel(progress: ThreadsPublishProgress): string {
  switch (progress.stage) {
    case 'checking':
      return progress.kind === 'reply' ? '댓글 정보 확인 중' : '업로드 정보 확인 중';
    case 'confirming':
      return progress.kind === 'reply'
        ? '댓글 게시 확인을 기다리는 중'
        : '업로드 확인을 기다리는 중';
    case 'preparing':
      return progress.kind === 'reply' ? '댓글 게시 준비 중' : '업로드 준비 중';
    case 'uploading':
      return progress.kind === 'reply'
        ? '댓글 전송 중'
        : `${progress.mediaKind === 'video' ? '영상' : '이미지'} 업로드 중`;
    case 'processing':
      return progress.kind === 'reply' ? 'Threads에서 댓글 처리 중' : 'Threads에서 미디어 확인 중';
    case 'publishing':
      return progress.kind === 'reply' ? 'Threads에 댓글 게시 중' : 'Threads에 게시 중';
    case 'saving':
      return progress.kind === 'reply' ? '댓글 결과 저장 중' : '등록 결과 저장 중';
    case 'cleaning':
      return progress.kind === 'reply' ? '댓글 게시 마무리 중' : '업로드 마무리 중';
  }
}

export function ThreadsUploadOverlay({ progress }: { progress: ThreadsPublishProgress }) {
  const hasCount =
    progress.kind === 'post' &&
    ['uploading', 'processing'].includes(progress.stage) &&
    !!progress.current &&
    !!progress.total;
  return (
    <ThreadsWorkOverlay
      label={progress.kind === 'reply' ? 'Threads 댓글 게시 진행' : 'Threads 업로드 진행'}
      title={threadsUploadLabel(progress)}
      detail={hasCount ? `첨부 ${progress.current} / ${progress.total}` : undefined}
    />
  );
}

export function ThreadsWorkOverlay({
  label,
  title,
  detail,
}: {
  label: string;
  title: string;
  detail?: string;
}) {
  const layer = useRef<HTMLElement>(null);
  useEffect(() => {
    layer.current?.focus({ preventScroll: true });
  }, []);
  return (
    <section
      ref={layer}
      className="threads-upload-overlay"
      tabIndex={-1}
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === 'Tab') event.preventDefault();
      }}
    >
      <div className="threads-upload-card">
        <span className="threads-upload-spinner" aria-hidden="true" />
        <div role="status" aria-live="polite" aria-atomic="true">
          <h3>{title}</h3>
          {detail && <p className="threads-upload-count">{detail}</p>}
        </div>
        <p>완료될 때까지 잠시 기다려 주세요.</p>
      </div>
    </section>
  );
}
