import { useEffect, useRef, useState, type RefObject } from 'react';
import { Icon } from './Icon';
import { timeInput, trimRange } from './trim-model';

export function VideoEditControls({
  videoRef,
  disabled,
  working,
  onCapture,
  onTrim,
  onClose,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  disabled: boolean;
  working: boolean;
  onCapture(): void;
  onTrim(start: number, end: number): void;
  onClose(): void;
}) {
  const [mode, setMode] = useState<'trim' | 'capture'>('trim');
  const [duration, setDuration] = useState(0);
  const [start, setStart] = useState('0');
  const [end, setEnd] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const previewEnd = useRef<number | null>(null);
  const previewRevision = useRef(0);
  const initialized = useRef(false);
  const range = trimRange(start, end, duration);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const metadata = () => {
      const length = video.duration;
      if (!Number.isFinite(length) || length <= 0) return;
      setDuration(length);
      if (!initialized.current) {
        initialized.current = true;
        setEnd(timeInput(length));
      }
    };
    const stopAtEnd = () => {
      const boundary = previewEnd.current;
      if (boundary !== null && video.currentTime >= boundary) {
        previewEnd.current = null;
        video.pause();
        video.currentTime = boundary;
        setPreviewing(false);
      }
    };
    const stopped = () => {
      previewEnd.current = null;
      setPreviewing(false);
    };
    metadata();
    video.addEventListener('loadedmetadata', metadata);
    video.addEventListener('durationchange', metadata);
    video.addEventListener('timeupdate', stopAtEnd);
    video.addEventListener('pause', stopped);
    video.addEventListener('ended', stopped);
    return () => {
      video.removeEventListener('loadedmetadata', metadata);
      video.removeEventListener('durationchange', metadata);
      video.removeEventListener('timeupdate', stopAtEnd);
      video.removeEventListener('pause', stopped);
      video.removeEventListener('ended', stopped);
      previewRevision.current += 1;
      if (previewEnd.current !== null) video.pause();
      previewEnd.current = null;
    };
  }, [videoRef]);

  function stopPreview() {
    previewRevision.current += 1;
    if (previewEnd.current !== null) videoRef.current?.pause();
    previewEnd.current = null;
    setPreviewing(false);
    setPreviewError('');
  }
  async function preview() {
    const video = videoRef.current;
    if (range.error || !video || disabled) return;
    if (previewing) {
      stopPreview();
      return;
    }
    const revision = ++previewRevision.current;
    setPreviewError('');
    try {
      video.currentTime = range.start;
      previewEnd.current = range.end;
      setPreviewing(true);
      await video.play();
    } catch {
      if (previewRevision.current === revision) {
        previewEnd.current = null;
        setPreviewing(false);
        setPreviewError('영상이 준비된 뒤 다시 미리보기하세요.');
      }
    }
  }

  return (
    <section className="video-edit-controls" aria-label="영상 편집">
      <div className="video-edit-heading">
        <div className="video-edit-modes" role="group" aria-label="영상 편집 방식">
          {(['trim', 'capture'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              disabled={working}
              onClick={() => {
                stopPreview();
                setMode(value);
              }}
            >
              <Icon name={value === 'trim' ? 'scissors' : 'camera'} />
              {value === 'trim' ? '구간 자르기' : '이미지 캡처'}
            </button>
          ))}
        </div>
        <button type="button" disabled={working} onClick={onClose}>
          편집 닫기
        </button>
      </div>
      {mode === 'trim' ? (
        <>
          <div className="video-trim-fields">
            <label>
              시작 (초)
              <input
                type="number"
                min="0"
                max={duration || undefined}
                step="any"
                value={start}
                disabled={disabled}
                aria-describedby="trim-help"
                onChange={(event) => {
                  stopPreview();
                  setStart(event.target.value);
                }}
              />
            </label>
            <span className="trim-range-divider">~</span>
            <label>
              종료 (초)
              <input
                type="number"
                min="0"
                max={duration || undefined}
                step="any"
                value={end}
                disabled={disabled}
                aria-describedby="trim-help"
                onChange={(event) => {
                  stopPreview();
                  setEnd(event.target.value);
                }}
              />
            </label>
            <div className="video-trim-actions">
              <button
                type="button"
                disabled={disabled || !!range.error}
                onClick={() => void preview()}
              >
                <Icon name="play" />
                {previewing ? '미리보기 중지' : '구간 미리보기'}
              </button>
              <button
                type="button"
                className="primary"
                disabled={disabled || !!range.error}
                onClick={() => {
                  if (!range.error) {
                    stopPreview();
                    onTrim(range.start, range.end);
                  }
                }}
              >
                <Icon name="scissors" />
                {working ? '영상 생성 중…' : '새 영상 만들기'}
              </button>
            </div>
          </div>
          <p
            id="trim-help"
            className={range.error || previewError ? 'trim-help trim-error' : 'trim-help'}
            aria-live="polite"
          >
            {previewError ||
              range.error ||
              `전체 ${timeInput(duration)}초 · 선택 ${timeInput(range.length)}초`}
          </p>
        </>
      ) : (
        <div className="video-capture-actions">
          <span className="capture-help">재생 중이거나 멈춘 현재 장면을 이미지로 저장합니다.</span>
          <button type="button" className="primary" disabled={disabled} onClick={onCapture}>
            <Icon name="camera" />
            {working ? '저장 중…' : '이미지로 캡처'}
          </button>
        </div>
      )}
    </section>
  );
}
