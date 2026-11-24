import { useEffect, useRef, useState, type DragEvent } from 'react';
import { DAILY_MEDIA_LIMIT, type DailyMedia, type DailyMediaResult } from '../shared/daily';
import { Icon } from './Icon';
import { useToast } from './toast';
import { moveRegistrationMedia } from './registration-model';

function Preview({ file, thumbnail = false }: { file: DailyMedia; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (!file.url) return <span className="registration-media-missing">파일 없음</span>;
  if (failed) return <span className="registration-media-missing">미리보기를 열 수 없습니다.</span>;
  return file.kind === 'image' ? (
    <img
      src={file.url}
      alt={thumbnail ? '' : file.name}
      draggable={false}
      onError={() => setFailed(true)}
    />
  ) : (
    <video
      src={file.url}
      aria-label={file.name}
      controls={!thumbnail}
      muted={thumbnail}
      playsInline
      preload="metadata"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/**
 * The images and videos of a daily post (2026-11-24), laid out like the attachments of the
 * collection's [등록] window: chosen or dropped files, put in order or left out, never edited.
 */
export function DailyMediaField({
  media,
  selectionId,
  ready,
  disabled,
  onChange,
  onAdd,
  onImporting,
}: {
  /** The attachments in posting order. */
  media: DailyMedia[];
  /** The dialog's selection the added files went into; null before its first files. */
  selectionId: string | null;
  /** A work folder is set, so files can be added. */
  ready: boolean;
  disabled: boolean;
  /** The attachments after a move or a removal. */
  onChange(media: DailyMedia[]): void;
  /** Files copied into `selectionId`, to go after the shown ones. */
  onAdd(selectionId: string, added: DailyMedia[]): void;
  onImporting(importing: boolean): void;
}) {
  const notify = useToast();
  const mounted = useRef(false);
  const pending = useRef(false);
  const dragDepth = useRef(0);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const room = DAILY_MEDIA_LIMIT - media.length;
  const locked = disabled || importing;
  const canAdd = ready && room > 0 && !locked;
  const currentIndex = Math.max(
    0,
    media.findIndex((file) => file.id === activeId),
  );
  const current = media[currentIndex];

  useEffect(() => {
    mounted.current = true;
    // A file dropped outside the field must never navigate the app away.
    const preventNavigation = (event: globalThis.DragEvent) => event.preventDefault();
    const resetDrag = () => {
      dragDepth.current = 0;
      setDragging(false);
    };
    window.addEventListener('dragover', preventNavigation);
    window.addEventListener('drop', preventNavigation);
    window.addEventListener('drop', resetDrag);
    window.addEventListener('dragend', resetDrag);
    window.addEventListener('blur', resetDrag);
    return () => {
      mounted.current = false;
      window.removeEventListener('dragover', preventNavigation);
      window.removeEventListener('drop', preventNavigation);
      window.removeEventListener('drop', resetDrag);
      window.removeEventListener('dragend', resetDrag);
      window.removeEventListener('blur', resetDrag);
    };
  }, []);

  async function addFiles(files?: File[]) {
    if (pending.current || !canAdd) return;
    pending.current = true;
    setImporting(true);
    onImporting(true);
    const input = { ...(selectionId ? { selectionId } : {}), room };
    try {
      const result: DailyMediaResult = files
        ? await window.threadsMedia.addDailyMedia({ ...input, files })
        : await window.threadsMedia.pickDailyMedia(input);
      if (result.status === 'cancelled') return;
      if (result.status === 'error')
        throw new Error(result.problem?.message ?? '파일을 가져오지 못했습니다.');
      if (!result.selectionId) return;
      if (!mounted.current) {
        // The dialog closed while the files were copied; nothing will save them.
        await window.threadsMedia.discardDailyMedia({ selectionId: result.selectionId });
        return;
      }
      onAdd(result.selectionId, result.media);
    } catch (error) {
      if (mounted.current)
        notify({
          error: true,
          message: error instanceof Error ? error.message : '파일을 가져오지 못했습니다.',
        });
    } finally {
      pending.current = false;
      if (mounted.current) {
        setImporting(false);
        onImporting(false);
      }
    }
  }
  const fileDrag = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes('Files');
  function dropFiles(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (pending.current || !canAdd) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      notify({ error: true, message: '컴퓨터에 저장된 이미지·영상 파일을 끌어다 놓으세요.' });
      return;
    }
    // Read File objects synchronously while the native drop data store is available.
    void addFiles(files);
  }
  const order = (ids: string[]) => onChange(ids.map((id) => media.find((file) => file.id === id)!));
  const ids = media.map((file) => file.id);

  return (
    <section
      className={`registration-section local-post-dropzone daily-media-field${dragging ? ' is-dragging' : ''}`}
      aria-label="이미지·영상"
      aria-busy={importing}
      onDragEnter={(event) => {
        if (!fileDrag(event)) return;
        event.preventDefault();
        if (pending.current || !canAdd) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect =
          fileDrag(event) && !pending.current && canAdd ? 'copy' : 'none';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={dropFiles}
    >
      <div className="registration-section-heading">
        <h3>
          이미지·영상{' '}
          <span>
            {media.length} / {DAILY_MEDIA_LIMIT}
          </span>
        </h3>
        <button type="button" disabled={!canAdd} onClick={() => void addFiles()}>
          <Icon name="folder" /> {importing ? '가져오는 중…' : '파일 선택'}
        </button>
      </div>
      {current ? (
        <div className="registration-selection-box">
          <div className="registration-preview">
            <Preview key={current.id} file={current} />
            <span className="registration-preview-count">
              {currentIndex + 1} / {media.length}
            </span>
          </div>
          <div className="registration-strip registration-selected-strip" aria-label="첨부 순서">
            {media.map((file, index) => (
              <div className="registration-selected-item" key={file.id}>
                <button
                  type="button"
                  className="registration-selected-thumb"
                  aria-current={current.id === file.id}
                  aria-label={`${index + 1}. ${file.name}`}
                  disabled={locked}
                  onClick={() => setActiveId(file.id)}
                >
                  <span className="registration-thumbnail">
                    <Preview file={file} thumbnail />
                  </span>
                  <span className="local-post-filename" title={file.name}>
                    {index + 1}. {file.name}
                  </span>
                </button>
                <div className="registration-order-actions">
                  <button
                    type="button"
                    aria-label={`${index + 1}번 미디어 앞으로`}
                    disabled={locked || index === 0}
                    onClick={() => order(moveRegistrationMedia(ids, file.id, index - 1))}
                  >
                    <Icon name="left" />
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}번 미디어 제외`}
                    disabled={locked}
                    onClick={() => onChange(media.filter((entry) => entry.id !== file.id))}
                  >
                    <Icon name="close" />
                  </button>
                  <button
                    type="button"
                    aria-label={`${index + 1}번 미디어 뒤로`}
                    disabled={locked || index === media.length - 1}
                    onClick={() => order(moveRegistrationMedia(ids, file.id, index + 1))}
                  >
                    <Icon name="right" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="registration-empty">
          <Icon name="image" />
          <p>이미지·영상을 여기에 끌어다 놓거나 파일 선택을 누르세요.</p>
        </div>
      )}
      <p className="registration-hint local-post-hint">
        {ready
          ? '선택한 파일은 앱 작업 폴더에 복사해 보관합니다.'
          : '작업 폴더를 지정하면 이미지·영상을 첨부할 수 있습니다.'}
      </p>
      {dragging && (
        <div className="local-post-drop-overlay" aria-hidden="true">
          <Icon name="plus" />
          <span>여기에 놓아 이미지·영상 추가</span>
        </div>
      )}
    </section>
  );
}
