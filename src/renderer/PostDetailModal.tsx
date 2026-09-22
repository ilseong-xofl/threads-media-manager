import { useEffect, useRef, useState } from 'react';
import type { Attachment, MediaEditInput, Post } from '../shared/contracts';
import { displayDate, postMedia } from './view-model';
import { Icon } from './Icon';
import { MediaCarousel } from './MediaCarousel';
import { ImageCropEditor } from './ImageCropEditor';
import { captureVideoFrame } from './capture-frame';
import { VideoEditControls } from './VideoEditControls';
import { PostLink } from './PostLink';

export function PostDetailModal({
  post,
  ordinal,
  onChange,
  onClose,
  editDisabled,
  onEdit,
  onRegister,
}: {
  post: Post;
  ordinal?: number;
  onChange(ordinal: number): void;
  onClose(): void;
  editDisabled: boolean;
  onEdit(input: MediaEditInput): Promise<Attachment | null>;
  onRegister(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const backdropDown = useRef(false);
  const items = postMedia(post);
  const item = items.find((attachment) => attachment.ordinal === ordinal) ?? items[0];
  const video = useRef<HTMLVideoElement>(null);
  const pending = useRef(false);
  const [editing, setEditing] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string } | null>(null);
  const imageEditing = editing && item?.kind === 'image' && !!item.localUrl;
  const canEdit = !!item?.mediaId && !!item.localUrl && item.status === 'saved';
  useEffect(() => {
    setEditing(false);
  }, [item?.mediaId]);
  useEffect(() => {
    if (!notice || notice.error) return;
    const timer = setTimeout(() => setNotice(null), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  async function saveEdit(makeInput: () => Promise<MediaEditInput> | MediaEditInput) {
    if (pending.current || editDisabled) return;
    pending.current = true;
    setWorking(true);
    setNotice(null);
    try {
      const input = await makeInput();
      const saved = await onEdit(input);
      if (input.kind === 'crop' || input.kind === 'trim') {
        setEditing(false);
        if (saved) onChange(saved.ordinal);
      }
      setNotice({
        error: !saved,
        message: saved
          ? '편집본이 캐러셀에 추가되었습니다.'
          : '편집본은 저장되었습니다. 상세 화면을 닫고 새로고침해 확인하세요.',
      });
    } catch (error) {
      setNotice({
        error: true,
        message:
          error instanceof Error ? error.message : '편집본을 저장하지 못했습니다. 다시 시도하세요.',
      });
    } finally {
      pending.current = false;
      setWorking(false);
    }
  }
  useEffect(() => {
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (element && !element.open) element.showModal();
    close.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  function outside(x: number, y: number) {
    const bounds = dialog.current?.getBoundingClientRect();
    return bounds
      ? x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
      : false;
  }
  return (
    <dialog
      className="post-modal"
      ref={dialog}
      aria-labelledby="post-detail-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!pending.current) onClose();
      }}
      onPointerDown={(event) => {
        backdropDown.current =
          event.target === event.currentTarget && outside(event.clientX, event.clientY);
      }}
      onClick={(event) => {
        if (
          backdropDown.current &&
          event.target === event.currentTarget &&
          outside(event.clientX, event.clientY)
        )
          if (!pending.current) onClose();
      }}
    >
      <header className="modal-header">
        <h2 id="post-detail-title">{editing ? '컨텐츠 편집' : '상세 화면'}</h2>
        <button
          className="icon-button modal-close"
          ref={close}
          type="button"
          aria-label={editing ? '컨텐츠 편집 닫기' : '상세 화면 닫기'}
          disabled={working}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="modal-body">
        {imageEditing ? (
          <ImageCropEditor
            key={item.mediaId}
            src={item.localUrl!}
            saving={working}
            onCancel={() => {
              setEditing(false);
              setNotice(null);
            }}
            onSave={(crop) =>
              void saveEdit(() => ({
                postKey: post.key,
                mediaId: item.mediaId!,
                kind: 'crop',
                crop,
              }))
            }
          />
        ) : (
          <MediaCarousel
            items={items}
            videoRef={video}
            disabled={working}
            ordinal={ordinal}
            onChange={(next) => {
              setNotice(null);
              onChange(next);
            }}
            detail
            label={`@${post.account} 게시글 첨부`}
          />
        )}
        {!imageEditing && (
          <div className="detail-content">
            <div className="detail-author">
              <h3>@{post.account}</h3>
              <p>{displayDate(post.publishedAt)} · KST</p>
            </div>
            <section className="detail-section">
              <h3>원문 캡션</h3>
              <p className={`caption ${post.caption ? '' : 'muted'}`}>
                {post.caption ||
                  (post.captionStatus === 'complete'
                    ? '캡션이 없는 게시글입니다.'
                    : '확인된 캡션이 없습니다.')}
              </p>
            </section>
            {post.originalUrl && (
              <section className="detail-section">
                <h3>원문 주소</h3>
                <PostLink postKey={post.key} kind="original" url={post.originalUrl} />
              </section>
            )}
            <details className="collection-details" open>
              <summary>수집·파일 정보</summary>
              <dl className="metadata">
                <div>
                  <dt>게시글 ID</dt>
                  <dd>{post.postId}</dd>
                </div>
                <div>
                  <dt>최근 확인 · KST</dt>
                  <dd>{displayDate(post.observedAt)}</dd>
                </div>
                <div>
                  <dt>첫 수집 · KST</dt>
                  <dd>{displayDate(post.collectedAt)}</dd>
                </div>
                <div>
                  <dt>캡션 확인 · KST</dt>
                  <dd>{displayDate(post.captionObservedAt)}</dd>
                </div>
                {item && !item.editType && (
                  <>
                    <div>
                      <dt>첨부 주소</dt>
                      <dd>
                        {item.addressStatus === 'http_candidate'
                          ? '확인됨'
                          : item.addressStatus === 'blob_unresolved'
                            ? '직접 주소 확인 필요'
                            : '미확인'}
                      </dd>
                    </div>
                    <div>
                      <dt>주소 확보 · KST</dt>
                      <dd>{displayDate(item.observedAt)}</dd>
                    </div>
                  </>
                )}
              </dl>
              <p className="source-file">원본 {post.source || '연결 필요'}</p>
            </details>
          </div>
        )}
      </div>
      {notice && (
        <p
          className={`editor-notice ${notice.error ? 'editor-error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.message}
        </p>
      )}
      {!imageEditing && (
        <div className="media-editor-footer">
          {editing && item?.kind === 'video' ? (
            <VideoEditControls
              key={item.mediaId}
              videoRef={video}
              disabled={working || editDisabled}
              working={working}
              onClose={() => {
                setEditing(false);
                setNotice(null);
              }}
              onCapture={() =>
                void saveEdit(async () => {
                  const frame = await captureVideoFrame(video.current);
                  return { postKey: post.key, mediaId: item.mediaId!, kind: 'capture', ...frame };
                })
              }
              onTrim={(start, end) =>
                void saveEdit(() => ({
                  postKey: post.key,
                  mediaId: item.mediaId!,
                  kind: 'trim',
                  start,
                  end,
                }))
              }
            />
          ) : (
            <>
              <button
                type="button"
                className="post-detail-action"
                disabled={!canEdit || editDisabled}
                onClick={() => {
                  setNotice(null);
                  setEditing(true);
                }}
              >
                <Icon name="edit" />
                편집
              </button>
              <button
                type="button"
                className="primary post-detail-action"
                disabled={editDisabled || working}
                onClick={onRegister}
              >
                <Icon name={post.draft ? 'eye' : 'plus'} />
                {post.draft ? '보기' : '작성'}
              </button>
            </>
          )}
        </div>
      )}
    </dialog>
  );
}
