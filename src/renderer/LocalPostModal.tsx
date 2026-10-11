import { useEffect, useRef, useState, type DragEvent } from 'react';
import type {
  CreateLocalPostInput,
  LocalPostMedia,
  LocalPostMediaSelection,
} from '../shared/contracts';
import { Icon } from './Icon';
import { useToast } from './toast';
import { MAX_DRAFT_CAPTION, moveRegistrationMedia } from './registration-model';

function Preview({ file, thumbnail = false }: { file: LocalPostMedia; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
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

export function LocalPostModal({
  onSave,
  onClose,
}: {
  onSave(input: CreateLocalPostInput): Promise<void>;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const chooseButton = useRef<HTMLButtonElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const session = useRef<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(false);
  const dragDepth = useRef(0);
  const notify = useToast();
  const [selection, setSelection] = useState<LocalPostMediaSelection | null>(null);
  const [mediaIds, setMediaIds] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const [working, setWorking] = useState<'picking' | 'saving' | null>(null);
  const [discard, setDiscard] = useState(false);
  const [dragging, setDragging] = useState(false);
  const currentIndex = Math.max(0, mediaIds.indexOf(activeId ?? ''));
  const current = selection?.files.find((file) => file.id === mediaIds[currentIndex]);

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overflow = document.body.style.overflow;
    document.querySelectorAll('video').forEach((video) => video.pause());
    element?.showModal();
    chooseButton.current?.focus();
    document.body.style.overflow = 'hidden';
    // A file dropped outside the dialog must never navigate the app away.
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
      element?.querySelectorAll('video').forEach((video) => video.pause());
      element?.close();
      document.body.style.overflow = overflow;
      if (session.current)
        void window.threadsMedia.discardLocalPostMedia(session.current).catch(() => undefined);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (discard) continueButton.current?.focus();
  }, [discard]);

  function requestClose() {
    if (pending.current) return;
    if (caption || selection) setDiscard(true);
    else onClose();
  }
  async function chooseFiles(files?: File[]) {
    if (pending.current || discard) return;
    pending.current = true;
    setWorking('picking');
    try {
      const result = files
        ? await window.threadsMedia.addLocalPostMedia(
            files,
            selection ? { selectionId: selection.selectionId, mediaIds } : undefined,
          )
        : await window.threadsMedia.pickLocalPostMedia();
      if (result.status === 'error') throw new Error(result.problem.message);
      if (result.status !== 'selected') return;
      if (!mounted.current) {
        await window.threadsMedia.discardLocalPostMedia(result.selectionId);
        return;
      }
      const previous = session.current;
      session.current = result.selectionId;
      setSelection(result);
      setMediaIds(result.files.map((file) => file.id));
      setActiveId(
        files && result.files.some((file) => file.id === activeId)
          ? activeId
          : (result.files[0]?.id ?? null),
      );
      if (previous && previous !== result.selectionId)
        await window.threadsMedia.discardLocalPostMedia(previous);
    } catch (error) {
      if (mounted.current)
        notify({
          error: true,
          message: error instanceof Error ? error.message : '파일을 가져오지 못했습니다.',
        });
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(null);
    }
  }
  function fileDrag(event: DragEvent<HTMLDialogElement>) {
    return Array.from(event.dataTransfer.types).includes('Files');
  }
  function dropFiles(event: DragEvent<HTMLDialogElement>) {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (pending.current || discard) return;
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      notify({ error: true, message: '컴퓨터에 저장된 이미지·영상 파일을 끌어다 놓으세요.' });
      return;
    }
    // Read File objects synchronously while the native drop data store is available.
    void chooseFiles(files);
  }
  async function save() {
    if (pending.current || !selection || !mediaIds.length) return;
    pending.current = true;
    setWorking('saving');
    try {
      await onSave({ selectionId: selection.selectionId, mediaIds, caption });
    } catch (error) {
      if (mounted.current)
        notify({
          error: true,
          message: error instanceof Error ? error.message : '게시글을 등록하지 못했습니다.',
        });
    } finally {
      pending.current = false;
      if (mounted.current) setWorking(null);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="post-modal registration-modal local-post-modal"
      aria-labelledby="local-post-title"
      onDragEnter={(event) => {
        if (!fileDrag(event)) return;
        event.preventDefault();
        if (pending.current || discard) return;
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect =
          fileDrag(event) && !pending.current && !discard ? 'copy' : 'none';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }}
      onDrop={dropFiles}
      onCancel={(event) => {
        event.preventDefault();
        if (discard) setDiscard(false);
        else requestClose();
      }}
    >
      <header className="modal-header" inert={discard}>
        <h2 id="local-post-title">등록</h2>
        <button
          type="button"
          className="icon-button modal-close"
          aria-label="등록 창 닫기"
          disabled={!!working}
          onClick={requestClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="registration-form" inert={discard}>
        <div className="modal-body registration-body">
          <section
            className={`registration-section local-post-dropzone${dragging ? ' is-dragging' : ''}`}
            aria-labelledby="local-media-title"
            aria-busy={working === 'picking'}
          >
            <div className="registration-section-heading">
              <h3 id="local-media-title">
                이미지·영상 <span>{mediaIds.length}</span>
              </h3>
              <button
                type="button"
                ref={chooseButton}
                disabled={!!working}
                onClick={() => void chooseFiles()}
              >
                <Icon name="folder" />{' '}
                {working === 'picking'
                  ? '가져오는 중…'
                  : selection
                    ? '파일 다시 선택'
                    : '파일 선택'}
              </button>
            </div>
            {current ? (
              <div className="registration-selection-box">
                <div className="registration-preview">
                  <Preview key={current.id} file={current} />
                  <span className="registration-preview-count">
                    {currentIndex + 1} / {mediaIds.length}
                  </span>
                </div>
                <div
                  className="registration-strip registration-selected-strip"
                  aria-label="등록할 미디어 순서"
                >
                  {mediaIds.map((id, index) => {
                    const file = selection!.files.find((item) => item.id === id)!;
                    return (
                      <div className="registration-selected-item" key={id}>
                        <button
                          type="button"
                          className="registration-selected-thumb"
                          aria-current={current.id === id}
                          aria-label={`${index + 1}. ${file.name}`}
                          disabled={!!working}
                          onClick={() => setActiveId(id)}
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
                            disabled={!!working || index === 0}
                            onClick={() =>
                              setMediaIds(moveRegistrationMedia(mediaIds, id, index - 1))
                            }
                          >
                            <Icon name="left" />
                          </button>
                          <button
                            type="button"
                            aria-label={`${index + 1}번 미디어 제외`}
                            disabled={!!working}
                            onClick={() => setMediaIds(mediaIds.filter((entry) => entry !== id))}
                          >
                            <Icon name="close" />
                          </button>
                          <button
                            type="button"
                            aria-label={`${index + 1}번 미디어 뒤로`}
                            disabled={!!working || index === mediaIds.length - 1}
                            onClick={() =>
                              setMediaIds(moveRegistrationMedia(mediaIds, id, index + 1))
                            }
                          >
                            <Icon name="right" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div className="registration-empty">
                <Icon name="image" />
                <p>이미지·영상을 여기에 끌어다 놓거나 파일 선택을 누르세요.</p>
              </div>
            )}
            <p className="registration-hint local-post-hint">
              {selection && '파일을 끌어다 놓으면 선택한 목록 뒤에 추가됩니다. '}
              선택한 파일은 앱 작업 폴더에 복사해 보관합니다.
            </p>
            {dragging && (
              <div className="local-post-drop-overlay" aria-hidden="true">
                <Icon name="plus" />
                <span>여기에 놓아 이미지·영상 추가</span>
              </div>
            )}
          </section>
          <section className="registration-section" aria-labelledby="local-caption-title">
            <div className="registration-section-heading">
              <h3 id="local-caption-title">캡션</h3>
            </div>
            <textarea
              className="local-post-caption"
              aria-label="직접 작성 캡션"
              rows={6}
              maxLength={MAX_DRAFT_CAPTION}
              placeholder="게시할 캡션을 직접 작성하세요."
              value={caption}
              disabled={!!working}
              onChange={(event) => setCaption(event.target.value)}
            />
          </section>
        </div>
        <footer className="registration-footer">
          <p className="registration-hint" role="status">
            {working === 'saving'
              ? '파일을 확인하고 게시글을 저장하고 있습니다.'
              : '등록 후 API 업로드 버튼으로 게시할 수 있습니다.'}
          </p>
          <div className="registration-actions">
            <button type="button" onClick={requestClose} disabled={!!working}>
              닫기
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => void save()}
              disabled={!!working || !mediaIds.length}
            >
              {working === 'saving' ? '등록 중…' : '등록'}
            </button>
          </div>
        </footer>
      </div>
      {discard && (
        <section
          className="registration-discard"
          role="alertdialog"
          aria-labelledby="local-discard-title"
          aria-describedby="local-discard-description"
        >
          <h3 id="local-discard-title">작성 내용을 버릴까요?</h3>
          <p id="local-discard-description">저장하지 않은 미디어 선택과 캡션은 사라집니다.</p>
          <div className="registration-actions">
            <button type="button" ref={continueButton} onClick={() => setDiscard(false)}>
              계속 작성
            </button>
            <button type="button" className="primary" onClick={onClose}>
              버리고 닫기
            </button>
          </div>
        </section>
      )}
    </dialog>
  );
}
