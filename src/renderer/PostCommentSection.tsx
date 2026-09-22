import { useEffect, useRef, useState } from 'react';
import type { Post, SavePostCommentInput } from '../shared/contracts';
import { Icon } from './Icon';
import { PostLink } from './PostLink';

export function PostCommentSection({
  post,
  editing,
  onEditingChange,
  disabled,
  saving,
  problem,
  onSave,
}: {
  post: Post;
  editing: boolean;
  onEditingChange(value: boolean): void;
  disabled: boolean;
  saving: boolean;
  problem?: string;
  onSave(input: SavePostCommentInput): Promise<void>;
}) {
  const [caption, setCaption] = useState('');
  const [link, setLink] = useState('');
  const [error, setError] = useState<string | null>(null);
  const captionInput = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (editing) captionInput.current?.focus({ preventScroll: true });
  }, [editing]);

  function openForm() {
    setCaption(post.comment?.caption ?? '');
    setLink(post.comment?.link ?? '');
    setError(null);
    onEditingChange(true);
  }
  function restoreFocus() {
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  }
  async function save() {
    if (pending.current || disabled || saving) return;
    pending.current = true;
    setError(null);
    try {
      await onSave({ postKey: post.key, caption: caption.trim(), link: link.trim() });
      restoreFocus();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '댓글 정보를 저장하지 못했습니다.');
    } finally {
      pending.current = false;
    }
  }

  return (
    <section className="post-comment" aria-labelledby="post-comment-title">
      <h3 id="post-comment-title" className="section-divider">
        댓글 정보
      </h3>
      {editing ? (
        <form
          className="detail-section comment-form"
          aria-label="댓글 정보 입력"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <label htmlFor="comment-caption">캡션</label>
          <textarea
            id="comment-caption"
            ref={captionInput}
            rows={4}
            maxLength={10000}
            placeholder="댓글에 사용할 내용을 입력하세요."
            value={caption}
            disabled={saving}
            onChange={(event) => setCaption(event.target.value)}
          />
          <label htmlFor="comment-link">링크</label>
          <input
            id="comment-link"
            type="url"
            maxLength={2048}
            placeholder="https://"
            value={link}
            disabled={saving}
            onChange={(event) => setLink(event.target.value)}
          />
          <p className="comment-hint">
            캡션이나 링크를 입력하세요. 등록한 정보는 이 게시글에 저장됩니다.
          </p>
          {error && (
            <p className="comment-error" role="alert">
              {error}
            </p>
          )}
          <div className="comment-actions">
            <button
              type="button"
              disabled={saving}
              onClick={() => {
                onEditingChange(false);
                restoreFocus();
              }}
            >
              취소
            </button>
            <button
              type="submit"
              className="primary"
              disabled={disabled || saving || (!caption.trim() && !link.trim())}
            >
              {saving ? '저장 중…' : '저장'}
            </button>
          </div>
        </form>
      ) : post.comment ? (
        <div className="detail-section comment-content">
          <div className="comment-heading">
            <span>등록한 댓글</span>
            <div className="comment-heading-actions">
              <button
                ref={editButton}
                type="button"
                onClick={openForm}
                disabled={disabled}
                aria-label="댓글 정보 수정"
              >
                <Icon name="edit" />
                수정
              </button>
              <button
                type="button"
                disabled
                aria-label="댓글 API 업로드"
                title="API 업로드는 준비 중입니다."
              >
                <Icon name="upload" />
                API 업로드
              </button>
            </div>
          </div>
          {post.comment.caption && <p className="caption">{post.comment.caption}</p>}
          {post.comment.link && (
            <PostLink postKey={post.key} kind="comment" url={post.comment.link} />
          )}
        </div>
      ) : (
        <button
          ref={editButton}
          type="button"
          className="comment-empty"
          onClick={openForm}
          disabled={disabled}
        >
          <span>
            {problem ? '댓글 정보를 불러오지 못했습니다.' : '댓글 정보가 등록되지 않았습니다.'}
          </span>
          {!problem && <span className="comment-hint">클릭하여 캡션과 링크를 등록하세요.</span>}
        </button>
      )}
      {problem && (
        <p className="comment-error" role="alert">
          {problem}
        </p>
      )}
    </section>
  );
}
