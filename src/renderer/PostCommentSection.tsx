import { useEffect, useRef, useState } from 'react';
import type { Post, SavePostCommentInput } from '../shared/contracts';
import { Icon } from './Icon';
import { PostLink } from './PostLink';
import { useToast, useToastMessage } from './toast';
import { rememberTranslations, savedTranslation as translationToSave } from './registration-model';

export function PostCommentSection({
  post,
  editing,
  onEditingChange,
  disabled,
  saving,
  problem,
  onSave,
  onPublish,
  publishDisabled = true,
  published = false,
  mobilePublication = false,
  savedTranslation = null,
  onGenerate,
  generating = false,
  generateDisabled = false,
}: {
  post: Post;
  editing: boolean;
  onEditingChange(value: boolean): void;
  disabled: boolean;
  saving: boolean;
  problem?: string;
  onSave(input: SavePostCommentInput): Promise<void>;
  onPublish?(): void;
  publishDisabled?: boolean;
  published?: boolean;
  mobilePublication?: boolean;
  /** Korean of the saved comment, kept on this PC. */
  savedTranslation?: string | null;
  /** Three AI comment suggestions; null when the generation was cancelled. */
  onGenerate?(): Promise<{ comments: string[]; translations?: string[] } | null>;
  generating?: boolean;
  generateDisabled?: boolean;
}) {
  const [caption, setCaption] = useState('');
  const [link, setLink] = useState('');
  const [suggestions, setSuggestions] = useState<{
    comments: string[];
    translations?: string[];
  } | null>(null);
  const seenTranslations = useRef(new Map<string, string>());
  useEffect(() => {
    if (suggestions)
      rememberTranslations(
        seenTranslations.current,
        suggestions.comments,
        suggestions.translations,
      );
  }, [suggestions]);
  const notify = useToast();
  useToastMessage(problem, true);
  const captionInput = useRef<HTMLTextAreaElement>(null);
  const editButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  useEffect(() => {
    if (editing) captionInput.current?.focus({ preventScroll: true });
  }, [editing]);

  function openForm() {
    setCaption(post.comment?.caption ?? '');
    setLink(post.comment?.link ?? '');
    setSuggestions(null);
    onEditingChange(true);
  }
  function restoreFocus() {
    requestAnimationFrame(() => editButton.current?.focus({ preventScroll: true }));
  }
  async function save() {
    if (pending.current || disabled || saving) return;
    pending.current = true;
    try {
      const text = caption.trim();
      await onSave({
        postKey: post.key,
        caption: text,
        link: link.trim(),
        translation: translationToSave(
          text,
          suggestions
            ? { texts: suggestions.comments, translations: suggestions.translations }
            : null,
          post.comment ? { text: post.comment.caption, translation: savedTranslation } : null,
          seenTranslations.current,
        ),
      });
      restoreFocus();
    } catch (cause) {
      notify({
        message: cause instanceof Error ? cause.message : '댓글 정보를 저장하지 못했습니다.',
        error: true,
      });
    } finally {
      pending.current = false;
    }
  }
  async function generate() {
    if (!onGenerate || disabled || generating || generateDisabled) return;
    setSuggestions(null);
    try {
      const result = await onGenerate();
      if (!result) return;
      if (!Array.isArray(result.comments) || result.comments.length !== 3)
        throw new Error('AI 댓글 제안 3개를 확인하지 못했습니다. 앱을 다시 실행해 주세요.');
      setSuggestions(result);
    } catch (cause) {
      notify({
        message: cause instanceof Error ? cause.message : 'AI 댓글을 만들지 못했습니다.',
        error: true,
      });
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
          {onGenerate && (
            <div className="comment-ai">
              <div className="registration-ai-header">
                <h4>AI 댓글</h4>
                <button
                  type="button"
                  className="registration-generate-button"
                  disabled={disabled || saving || generating || generateDisabled}
                  onClick={() => void generate()}
                >
                  {generating ? '생성 중…' : '생성'}
                </button>
              </div>
              {generating && (
                <p className="comment-hint" role="status">
                  저장한 캡션에 이어지는 댓글 제안 3개를 만들고 있습니다…
                </p>
              )}
              {suggestions && (
                <section className="registration-candidates" aria-label="AI 댓글 제안">
                  {suggestions.comments.map((comment, index) => {
                    const chosen = caption.trim() === comment;
                    return (
                      <article
                        key={index}
                        className={`registration-candidate${chosen ? ' is-selected' : ''}`}
                        aria-labelledby={`comment-candidate-${index}`}
                      >
                        <div className="registration-candidate-heading">
                          <h4 id={`comment-candidate-${index}`}>제안 {index + 1}</h4>
                          <button
                            type="button"
                            className="registration-candidate-select"
                            disabled={disabled || saving}
                            aria-pressed={chosen}
                            aria-label={
                              chosen
                                ? `댓글 제안 ${index + 1} 선택됨`
                                : `댓글 제안 ${index + 1}을 댓글 내용으로 선택`
                            }
                            onClick={() => setCaption(comment)}
                          >
                            {chosen ? '선택됨' : '선택'}
                          </button>
                        </div>
                        <p className="caption">{comment}</p>
                        {suggestions.translations?.[index] && (
                          <p className="registration-translation">
                            {suggestions.translations[index]}
                          </p>
                        )}
                      </article>
                    );
                  })}
                </section>
              )}
            </div>
          )}
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
              {!mobilePublication && (
                <button
                  type="button"
                  disabled={disabled || publishDisabled || !onPublish}
                  onClick={onPublish}
                  aria-label="댓글 API 업로드"
                  title={
                    published
                      ? '이미 게시한 댓글입니다.'
                      : '게시한 Threads 글에 등록한 댓글을 올립니다.'
                  }
                >
                  <Icon name="upload" />
                  {published ? '댓글 완료' : 'API 업로드'}
                </button>
              )}
            </div>
          </div>
          {post.comment.caption && <p className="caption">{post.comment.caption}</p>}
          {post.comment.caption && savedTranslation && (
            <p className="registration-translation">{savedTranslation}</p>
          )}
          {post.comment.link && (
            <PostLink postKey={post.key} kind="comment" url={post.comment.link} />
          )}
          {mobilePublication && (
            <p className="comment-hint">
              댓글은 게시본에 함께 보내며, 휴대폰에서 원글 게시 후 별도로 게시합니다.
            </p>
          )}
        </div>
      ) : !problem ? (
        <button
          ref={editButton}
          type="button"
          className="comment-empty"
          onClick={openForm}
          disabled={disabled}
        >
          <span>댓글 정보가 등록되지 않았습니다.</span>
          <span className="comment-hint">클릭하여 캡션과 링크를 등록하세요.</span>
        </button>
      ) : null}
    </section>
  );
}
