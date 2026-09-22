import { useRef, useState, type Ref } from 'react';
import type { Attachment } from '../shared/contracts';
import { Icon } from './Icon';

export const attachmentLabel = (item: Attachment) =>
  ({
    saved: '저장됨',
    not_downloaded: '다운로드 전',
    unavailable: '저장 상태 확인 필요',
    review: '파일 확인 필요',
  })[item.status];

function Media({
  item,
  detail,
  videoRef,
}: {
  item: Attachment;
  detail: boolean;
  videoRef?: Ref<HTMLVideoElement>;
}) {
  const [failed, setFailed] = useState(false);
  if (!item.localUrl || failed) {
    return (
      <div className="media-placeholder">
        <Icon name={item.kind === 'video' ? 'play' : 'image'} />
        <strong>{failed ? '미리보기를 열 수 없습니다' : attachmentLabel(item)}</strong>
        <span>
          {failed ? '저장된 파일의 상태는 유지됩니다.' : '파일을 다운로드하면 여기에 표시됩니다.'}
        </span>
      </div>
    );
  }
  return item.kind === 'image' ? (
    <img
      src={item.localUrl}
      alt={`${item.ordinal}번째 저장 이미지`}
      loading={detail ? 'eager' : 'lazy'}
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  ) : (
    <>
      <video
        ref={videoRef}
        crossOrigin="anonymous"
        src={item.localUrl}
        controls={detail}
        autoPlay={detail}
        muted={!detail}
        playsInline
        preload="metadata"
        tabIndex={detail ? 0 : -1}
        aria-label={`${item.ordinal}번째 저장 영상`}
        onError={() => setFailed(true)}
      />
      {!detail && (
        <span className="play-indicator">
          <Icon name="play" />
        </span>
      )}
    </>
  );
}

export function MediaCarousel({
  items,
  ordinal,
  onChange,
  detail = false,
  onOpen,
  label,
  videoRef,
  disabled = false,
  onDeleteEdit,
  deleteDisabled = false,
  includeEditsInType = false,
}: {
  items: Attachment[];
  ordinal?: number;
  onChange(ordinal: number): void;
  detail?: boolean;
  onOpen?(): void;
  label: string;
  videoRef?: Ref<HTMLVideoElement>;
  disabled?: boolean;
  onDeleteEdit?(mediaId: string): void;
  deleteDisabled?: boolean;
  includeEditsInType?: boolean;
}) {
  const found = items.findIndex((item) => item.ordinal === ordinal);
  const index = found < 0 ? 0 : found;
  const item = items[index];
  const multiple = items.length > 1;
  const originals = includeEditsInType ? items : items.filter((attachment) => !attachment.editType);
  const hasImages = originals.some((attachment) => attachment.kind === 'image');
  const hasVideos = originals.some((attachment) => attachment.kind === 'video');
  const mediaTypeLabel = hasVideos ? (hasImages ? '영상 & 이미지' : '영상') : '이미지';
  const touch = useRef<{ x: number; y: number } | null>(null);
  const swipeUntil = useRef(0);
  function move(step: number) {
    if (multiple && !disabled)
      onChange(items[(index + step + items.length) % items.length].ordinal);
  }
  const media = item ? (
    <Media
      key={`${item.ordinal}:${item.localUrl}:${item.status}`}
      item={item}
      detail={detail}
      videoRef={videoRef}
    />
  ) : (
    <div className="media-placeholder">
      <Icon name="image" />
      <strong>확인된 첨부가 없습니다</strong>
    </div>
  );
  return (
    <div
      className={`media-carousel ${detail ? 'media-carousel-detail' : 'media-carousel-card'}`}
      role="region"
      aria-roledescription="캐러셀"
      aria-label={label}
      tabIndex={detail && multiple ? 0 : undefined}
      onKeyDown={(event) => {
        if (disabled || !multiple || event.target instanceof HTMLVideoElement) return;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          event.stopPropagation();
          move(event.key === 'ArrowLeft' ? -1 : 1);
        }
      }}
    >
      <div
        className="media-stage"
        onTouchStart={(event) => {
          if (event.target instanceof HTMLVideoElement || event.touches.length !== 1) {
            touch.current = null;
            return;
          }
          touch.current = { x: event.touches[0].clientX, y: event.touches[0].clientY };
        }}
        onTouchCancel={() => {
          touch.current = null;
        }}
        onTouchEnd={(event) => {
          const start = touch.current;
          touch.current = null;
          if (!start || !multiple || !event.changedTouches[0]) return;
          const dx = event.changedTouches[0].clientX - start.x;
          const dy = event.changedTouches[0].clientY - start.y;
          if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) {
            swipeUntil.current = Date.now() + 500;
            move(dx < 0 ? 1 : -1);
          }
        }}
      >
        {onOpen ? (
          <button
            className="media-open"
            type="button"
            aria-label={`${label} 상세 보기`}
            onClick={() => {
              if (Date.now() >= swipeUntil.current) onOpen();
            }}
          >
            {media}
          </button>
        ) : (
          media
        )}
        {item && (
          <span className="media-type">
            <Icon name={hasVideos ? 'play' : 'image'} />
            {mediaTypeLabel}
          </span>
        )}
        {item?.editType && !detail && <span className="media-edit-badge">편집본</span>}
        {item?.editType && item.mediaId && onDeleteEdit && (
          <button
            type="button"
            className="media-delete-edit"
            aria-label="편집본 삭제"
            title="편집본 삭제"
            disabled={deleteDisabled}
            onClick={(event) => {
              event.stopPropagation();
              onDeleteEdit(item.mediaId!);
            }}
          >
            <Icon name="trash" />
          </button>
        )}
        {(multiple || (detail && item?.editType)) && (
          <div className="media-top-right">
            {detail && item?.editType && <span className="media-edit-badge">편집본</span>}
            {multiple && (
              <span className="media-counter" aria-live={detail ? 'polite' : 'off'}>
                {index + 1} / {items.length}
              </span>
            )}
          </div>
        )}
        {multiple && (
          <>
            <button
              className="carousel-arrow carousel-prev"
              type="button"
              disabled={disabled}
              aria-label="이전 첨부"
              onClick={() => move(-1)}
            >
              <Icon name="left" />
            </button>
            <button
              className="carousel-arrow carousel-next"
              type="button"
              disabled={disabled}
              aria-label="다음 첨부"
              onClick={() => move(1)}
            >
              <Icon name="right" />
            </button>
          </>
        )}
      </div>
      {multiple && (
        <div className="carousel-dots" aria-label="첨부 선택">
          {items.map((entry, i) => (
            <button
              key={entry.ordinal}
              disabled={disabled}
              type="button"
              className={i === index ? 'active' : ''}
              aria-label={`${i + 1}번째 첨부 보기`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => onChange(entry.ordinal)}
            >
              <span />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
