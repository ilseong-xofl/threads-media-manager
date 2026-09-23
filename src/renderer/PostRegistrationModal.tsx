import { useEffect, useRef, useState } from 'react';
import type {
  Attachment,
  CaptionLanguage,
  GenerateCaptionInput,
  Post,
  PostDraft,
  SavePostDraftInput,
  SavePostCommentInput,
} from '../shared/contracts';
import { Icon } from './Icon';
import { PostCommentSection } from './PostCommentSection';
import { postDraftExportIssue } from '../shared/post-export';
import {
  captionImageIds,
  captionGenerationInput,
  MAX_DRAFT_CAPTION,
  MAX_DRAFT_MEDIA,
  moveRegistrationMedia,
  registrationChanged,
  registrationInput,
  registrationMedia,
  registrationMediaLabel,
  selectableMedia,
  selectedRegistrationMedia,
  toggleRegistrationMedia,
} from './registration-model';
import './registration.css';

export interface PostRegistrationModalProps {
  post: Post;
  draft?: PostDraft;
  mode?: 'view' | 'edit';
  initialCandidates?: string[];
  initialLanguage?: CaptionLanguage;
  disabled?: boolean;
  onSave(input: SavePostDraftInput): Promise<void>;
  onGenerate(input: GenerateCaptionInput): Promise<string[] | null>;
  onCancelGeneration(): Promise<void>;
  onClose(): void;
  onSaveComment(input: SavePostCommentInput): Promise<void>;
  commentProblem?: string;
  onDelete(): void;
  onExport(): void;
  exporting?: boolean;
}

function MediaPreview({ item, thumbnail = false }: { item?: Attachment; thumbnail?: boolean }) {
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const element = video.current;
    return () => element?.pause();
  }, []);
  if (!item || !selectableMedia(item) || failed)
    return (
      <span className="registration-media-missing">
        <Icon name={item?.kind === 'video' ? 'play' : 'image'} />
        {!thumbnail && (
          <span>{failed ? '미리보기를 열 수 없습니다.' : '사용할 수 없는 미디어입니다.'}</span>
        )}
      </span>
    );
  return item.kind === 'image' ? (
    <img
      src={item.localUrl!}
      alt={thumbnail ? '' : '선택한 이미지'}
      draggable={false}
      onError={() => setFailed(true)}
    />
  ) : (
    <>
      <video
        ref={video}
        src={item.localUrl!}
        aria-label={thumbnail ? undefined : '선택한 영상'}
        controls={!thumbnail}
        muted={thumbnail}
        playsInline
        preload="metadata"
        tabIndex={thumbnail ? -1 : 0}
        onError={() => setFailed(true)}
      />
      {thumbnail && (
        <span className="registration-video-mark">
          <Icon name="play" />
        </span>
      )}
    </>
  );
}

export function PostRegistrationModal(props: PostRegistrationModalProps) {
  return <RegistrationDialog key={props.post.key} {...props} />;
}

function RegistrationDialog({
  post,
  draft,
  mode,
  initialCandidates,
  initialLanguage = 'en',
  disabled = false,
  onSave,
  onGenerate,
  onCancelGeneration,
  onClose,
  onSaveComment,
  commentProblem,
  onDelete,
  onExport,
  exporting = false,
}: PostRegistrationModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const continueEditing = useRef<HTMLButtonElement>(null);
  const sourceStrip = useRef<HTMLDivElement>(null);
  const selectedStrip = useRef<HTMLDivElement>(null);
  const backdropDown = useRef(false);
  const dragging = useRef<string | null>(null);
  const mounted = useRef(true);
  const savingRef = useRef(false);
  const generationRef = useRef(false);
  const commentSavingRef = useRef(false);
  const generationToken = useRef(0);
  const cancelRef = useRef(onCancelGeneration);
  cancelRef.current = onCancelGeneration;
  const [editing, setEditing] = useState((mode ?? (draft ? 'view' : 'edit')) === 'edit');
  const [baseline, setBaseline] = useState(() => ({
    caption: draft?.caption ?? '',
    mediaIds: [...(draft?.mediaIds ?? [])],
  }));
  const [revision, setRevision] = useState(draft?.revision ?? null);
  const [caption, setCaption] = useState(baseline.caption);
  const [mediaIds, setMediaIds] = useState(baseline.mediaIds);
  const [activeId, setActiveId] = useState<string | null>(mediaIds[0] ?? null);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [language, setLanguage] = useState<CaptionLanguage>(initialLanguage);
  const [candidates, setCandidates] = useState<string[] | null>(() =>
    initialCandidates ? [...initialCandidates] : null,
  );
  const [error, setError] = useState<string | null>(null);
  const [discard, setDiscard] = useState(false);
  const [commentEditing, setCommentEditing] = useState(false);
  const [commentSaving, setCommentSaving] = useState(false);
  const source = registrationMedia(post);
  const shownIds = editing ? mediaIds : (draft?.mediaIds ?? mediaIds);
  const selected = selectedRegistrationMedia(post, shownIds);
  const selectedImageIds = captionImageIds(post, mediaIds);
  const currentIndex = Math.max(0, shownIds.indexOf(activeId ?? ''));
  const current = selected[currentIndex];
  const unavailable = selected.filter(
    ({ attachment }) => !attachment || !selectableMedia(attachment),
  ).length;
  const dirty = (editing && registrationChanged(baseline, caption, mediaIds)) || commentEditing;
  const busy = saving || generating || commentSaving;
  const exportIssue = postDraftExportIssue(post);
  const selectionDisabled = disabled || busy;

  useEffect(() => {
    mounted.current = true;
    const element = dialog.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const preventBackgroundPlayback = (event: Event) => {
      if (event.target instanceof HTMLVideoElement && !element?.contains(event.target))
        event.target.pause();
    };
    document.querySelectorAll('video').forEach((video) => {
      if (!element?.contains(video)) video.pause();
    });
    document.addEventListener('play', preventBackgroundPlayback, true);
    if (element && !element.open) element.showModal();
    close.current?.focus();
    document.body.style.overflow = 'hidden';
    return () => {
      mounted.current = false;
      generationToken.current += 1;
      if (generationRef.current) void cancelRef.current().catch(() => undefined);
      element?.querySelectorAll('video').forEach((video) => video.pause());
      document.removeEventListener('play', preventBackgroundPlayback, true);
      element?.close();
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    if (discard) continueEditing.current?.focus();
  }, [discard]);
  useEffect(() => {
    const item = selectedStrip.current?.querySelector<HTMLElement>('[aria-current="true"]');
    if (item && selectedStrip.current) {
      const strip = selectedStrip.current;
      if (
        item.offsetLeft < strip.scrollLeft ||
        item.offsetLeft + item.offsetWidth > strip.scrollLeft + strip.clientWidth
      )
        strip.scrollTo({
          left: Math.max(0, item.offsetLeft - strip.clientWidth / 2 + item.offsetWidth / 2),
          behavior: 'smooth',
        });
    }
  }, [activeId]);

  function requestClose() {
    if (savingRef.current || generationRef.current || commentSavingRef.current) return;
    if (dirty) setDiscard(true);
    else onClose();
  }
  function outside(x: number, y: number) {
    const bounds = dialog.current?.getBoundingClientRect();
    return bounds
      ? x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom
      : false;
  }
  function updateSelection(next: string[], focusId?: string) {
    setMediaIds(next);
    setError(null);
    setActiveId(
      focusId ??
        (activeId && next.includes(activeId)
          ? activeId
          : (next[Math.min(currentIndex, next.length - 1)] ?? null)),
    );
  }
  function changeSelection(makeNext: () => string[], focusId?: string) {
    if (selectionDisabled || savingRef.current || generationRef.current) return;
    updateSelection(makeNext(), focusId);
  }
  function startEditing() {
    if (disabled || busy || commentEditing) return;
    const next = {
      caption: draft?.caption ?? '',
      mediaIds: [...(draft?.mediaIds ?? [])],
    };
    setBaseline(next);
    setCaption(next.caption);
    setMediaIds(next.mediaIds);
    setRevision(draft?.revision ?? null);
    setError(null);
    setEditing(true);
  }
  async function save() {
    if (disabled || savingRef.current || generationRef.current) return;
    setError(null);
    try {
      const input = registrationInput(post, caption, mediaIds, revision);
      savingRef.current = true;
      setSaving(true);
      await onSave(input);
      if (mounted.current) onClose();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : '게시글을 저장하지 못했습니다.');
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  }
  async function saveComment(input: SavePostCommentInput) {
    if (disabled || busy || commentSavingRef.current || commentProblem || !draft)
      throw new Error(commentProblem || '다른 작업이 끝난 뒤 저장하세요.');
    commentSavingRef.current = true;
    setCommentSaving(true);
    try {
      await onSaveComment(input);
      if (mounted.current) setCommentEditing(false);
    } finally {
      commentSavingRef.current = false;
      if (mounted.current) setCommentSaving(false);
    }
  }
  async function generate() {
    if (disabled || savingRef.current || generationRef.current || !selectedImageIds.length) return;
    setError(null);
    setCandidates(null);
    try {
      const input = captionGenerationInput(post, mediaIds, language, revision);
      generationRef.current = true;
      const token = ++generationToken.current;
      setGenerating(true);
      try {
        const result = await onGenerate(input);
        if (mounted.current && token === generationToken.current && result !== null) {
          if (!Array.isArray(result) || result.length !== 3)
            throw new Error('AI 캡션 제안 3개를 확인하지 못했습니다. 앱을 다시 실행해 주세요.');
          result.forEach((candidate) => registrationInput(post, candidate, mediaIds, revision));
          setCandidates(result);
        }
      } catch (cause) {
        if (mounted.current && token === generationToken.current)
          setError(cause instanceof Error ? cause.message : 'AI 캡션을 만들지 못했습니다.');
      } finally {
        generationRef.current = false;
        if (mounted.current) {
          setGenerating(false);
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '선택한 미디어를 확인하세요.');
    }
  }
  function dismissDiscard() {
    setDiscard(false);
    requestAnimationFrame(() => close.current?.focus());
  }
  function moveCurrent(step: number) {
    if (busy || !shownIds.length) return;
    setActiveId(shownIds[(currentIndex + step + shownIds.length) % shownIds.length]);
  }

  return (
    <dialog
      ref={dialog}
      className="post-modal registration-modal"
      aria-labelledby="registration-title"
      onCancel={(event) => {
        event.preventDefault();
        if (discard) dismissDiscard();
        else requestClose();
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
          requestClose();
      }}
    >
      <header className="modal-header" inert={discard}>
        <div>
          <h2 id="registration-title">{editing ? '등록 화면' : '상세 화면'}</h2>
          <p className="registration-account">@{post.account}</p>
        </div>
        <button
          type="button"
          ref={close}
          className="icon-button modal-close"
          aria-label={editing ? '등록 화면 닫기' : '상세 화면 닫기'}
          disabled={busy}
          onClick={requestClose}
        >
          <Icon name="close" />
        </button>
      </header>
      <div className="registration-form" inert={discard}>
        <div className="modal-body registration-body">
          {editing && (
            <section className="registration-section" aria-labelledby="registration-source-title">
              <div className="registration-section-heading">
                <h3 id="registration-source-title">미디어 선택</h3>
                <span>
                  {post.aiImages ? '원본·편집본·AI 생성본에서 선택' : '원본·편집본에서 선택'}
                </span>
              </div>
              <div className="registration-strip-wrapper">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="이전 미디어"
                  onClick={() => sourceStrip.current?.scrollBy({ left: -300, behavior: 'smooth' })}
                >
                  <Icon name="left" />
                </button>
                <div className="registration-strip registration-source-strip" ref={sourceStrip}>
                  {source.map((item, index) => {
                    const chosen = !!item.mediaId && mediaIds.includes(item.mediaId);
                    const label = `${registrationMediaLabel(item)} ${index + 1}${item.kind === 'video' ? ' 영상' : ' 이미지'}`;
                    return (
                      <button
                        type="button"
                        className="registration-source-item"
                        key={`${item.mediaId}:${item.ordinal}`}
                        aria-label={`${label}${chosen ? ' 선택 해제' : ' 선택'}`}
                        aria-pressed={chosen}
                        disabled={
                          selectionDisabled ||
                          (!chosen &&
                            (!selectableMedia(item) || mediaIds.length >= MAX_DRAFT_MEDIA))
                        }
                        onClick={() =>
                          changeSelection(
                            () => toggleRegistrationMedia(post, mediaIds, item.mediaId!),
                            chosen ? undefined : item.mediaId!,
                          )
                        }
                      >
                        <span className="registration-thumbnail">
                          <MediaPreview
                            key={`${item.mediaId}:${item.localUrl}:${item.status}`}
                            item={item}
                            thumbnail
                          />
                          {chosen && (
                            <span className="registration-selected-mark">
                              <Icon name="check" />
                            </span>
                          )}
                        </span>
                        <span className="registration-source-label">
                          <span>
                            {index + 1}/{source.length}
                          </span>
                          <span>{registrationMediaLabel(item)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="다음 미디어"
                  onClick={() => sourceStrip.current?.scrollBy({ left: 300, behavior: 'smooth' })}
                >
                  <Icon name="right" />
                </button>
              </div>
            </section>
          )}
          <section className="registration-section" aria-labelledby="registration-selected-title">
            <div className="registration-section-heading">
              <h3 id="registration-selected-title">
                {editing ? '선택한 미디어' : '등록한 미디어'} <span>{shownIds.length}</span>
              </h3>
              {editing && <span>드래그하거나 화살표로 순서 변경</span>}
            </div>
            {unavailable > 0 && (
              <p className="registration-warning" role="alert">
                사용할 수 없는 미디어가 {unavailable}개 있습니다.{' '}
                {editing
                  ? '해당 항목을 선택 목록에서 제거한 뒤 저장하세요.'
                  : '수정에서 해당 항목을 제거하거나 파일 상태를 확인하세요.'}
              </p>
            )}
            {current ? (
              <div className="registration-selection-box">
                <div
                  className="registration-preview"
                  role="region"
                  aria-roledescription="캐러셀"
                  aria-label="선택한 미디어 미리보기"
                >
                  <MediaPreview
                    key={`${current.mediaId}:${current.attachment?.localUrl}:${current.attachment?.status}`}
                    item={current.attachment}
                  />
                  {shownIds.length > 1 && (
                    <>
                      <button
                        type="button"
                        className="carousel-arrow carousel-prev"
                        disabled={busy}
                        aria-label="이전 선택 미디어"
                        onClick={() => moveCurrent(-1)}
                      >
                        <Icon name="left" />
                      </button>
                      <button
                        type="button"
                        className="carousel-arrow carousel-next"
                        disabled={busy}
                        aria-label="다음 선택 미디어"
                        onClick={() => moveCurrent(1)}
                      >
                        <Icon name="right" />
                      </button>
                    </>
                  )}
                  <span className="registration-preview-count" aria-live="polite">
                    {currentIndex + 1} / {shownIds.length}
                  </span>
                </div>
                <div className="registration-strip registration-selected-strip" ref={selectedStrip}>
                  {selected.map(({ mediaId, attachment }, index) => (
                    <div
                      className="registration-selected-item"
                      key={mediaId}
                      draggable={editing && !selectionDisabled}
                      onDragStart={(event) => {
                        if (!editing || selectionDisabled) {
                          event.preventDefault();
                          return;
                        }
                        dragging.current = mediaId;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('application/x-tmm-registration', mediaId);
                      }}
                      onDragEnd={() => {
                        dragging.current = null;
                      }}
                      onDragOver={(event) => {
                        if (dragging.current && !selectionDisabled) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                        }
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        const dragged = dragging.current;
                        dragging.current = null;
                        if (dragged)
                          changeSelection(
                            () => moveRegistrationMedia(mediaIds, dragged, index),
                            dragged,
                          );
                      }}
                    >
                      <button
                        type="button"
                        className="registration-selected-thumb"
                        disabled={busy}
                        aria-label={`${index + 1}번째 선택 미디어 보기`}
                        aria-current={index === currentIndex ? 'true' : undefined}
                        onClick={() => setActiveId(mediaId)}
                      >
                        <span className="registration-thumbnail">
                          <MediaPreview
                            key={`${mediaId}:${attachment?.localUrl}:${attachment?.status}`}
                            item={attachment}
                            thumbnail
                          />
                        </span>
                        <span>
                          {index + 1}
                          {attachment && (attachment.aiGenerated || attachment.editType)
                            ? ` · ${registrationMediaLabel(attachment)}`
                            : ''}
                          {!attachment || !selectableMedia(attachment) ? ' · 확인 필요' : ''}
                        </span>
                      </button>
                      {editing && (
                        <div className="registration-order-actions">
                          <button
                            type="button"
                            aria-label={`${index + 1}번째 미디어 앞으로 이동`}
                            disabled={selectionDisabled || index === 0}
                            onClick={() =>
                              changeSelection(
                                () => moveRegistrationMedia(mediaIds, mediaId, index - 1),
                                mediaId,
                              )
                            }
                          >
                            <Icon name="left" />
                          </button>
                          <button
                            type="button"
                            aria-label={`${index + 1}번째 미디어 뒤로 이동`}
                            disabled={selectionDisabled || index === mediaIds.length - 1}
                            onClick={() =>
                              changeSelection(
                                () => moveRegistrationMedia(mediaIds, mediaId, index + 1),
                                mediaId,
                              )
                            }
                          >
                            <Icon name="right" />
                          </button>
                          <button
                            type="button"
                            aria-label={`${index + 1}번째 미디어 선택 해제`}
                            disabled={selectionDisabled}
                            onClick={() =>
                              changeSelection(() => mediaIds.filter((id) => id !== mediaId))
                            }
                          >
                            <Icon name="close" />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="registration-empty">
                <Icon name="image" />
                <p>위에서 등록할 이미지나 영상을 선택하세요.</p>
              </div>
            )}
          </section>
          <section className="registration-section" aria-labelledby="registration-caption-title">
            <div className="registration-section-heading">
              <h3 id="registration-caption-title">캡션</h3>
            </div>
            <div className="registration-caption-box">
              <div
                className="registration-original-caption"
                aria-labelledby="registration-original-title"
              >
                <h4 className="registration-original-label" id="registration-original-title">
                  원본 캡션
                </h4>
                <p className="caption">{post.caption || '원본 캡션이 없습니다.'}</p>
              </div>
              {editing ? (
                <>
                  <textarea
                    id="registration-caption"
                    aria-label="등록 캡션"
                    rows={5}
                    value={caption}
                    maxLength={MAX_DRAFT_CAPTION}
                    disabled={disabled || saving}
                    placeholder="등록할 캡션을 직접 작성하거나 아래 AI 제안을 선택하세요."
                    onChange={(event) => setCaption(event.target.value)}
                  />
                  <div className="registration-ai-header">
                    <h4>AI 캡션</h4>
                    <div className="registration-ai-actions">
                      <div className="select-field registration-language">
                        <select
                          aria-label="AI 캡션 언어"
                          value={language}
                          disabled={disabled || busy}
                          onChange={(event) => setLanguage(event.target.value as CaptionLanguage)}
                        >
                          <option value="en">영어</option>
                          <option value="ko">한국어</option>
                          <option value="ja">일본어</option>
                        </select>
                        <Icon name="chevron" />
                      </div>
                      <button
                        type="button"
                        className="registration-generate-button"
                        disabled={disabled || busy || !selectedImageIds.length || unavailable > 0}
                        onClick={() => void generate()}
                      >
                        {generating ? '생성 중…' : '생성'}
                      </button>
                    </div>
                  </div>
                  <div
                    className={`registration-ai-area${candidates !== null ? ' has-candidates' : ''}`}
                  >
                    {candidates === null ? (
                      <div className="registration-generate-area" aria-busy={generating}>
                        <Icon
                          name={generating ? 'refresh' : 'edit'}
                          className={generating ? 'is-spinning' : ''}
                        />
                        <span role="status">
                          {generating
                            ? 'AI 캡션 제안 3개를 만들고 있습니다…'
                            : '언어를 선택한 뒤 생성 버튼을 눌러 AI 캡션 제안 3개를 만드세요.'}
                        </span>
                      </div>
                    ) : (
                      <section className="registration-candidates" aria-label="AI 캡션 제안">
                        {candidates.map((candidate, index) => {
                          const chosen = caption === candidate;
                          return (
                            <article
                              key={index}
                              className={`registration-candidate${chosen ? ' is-selected' : ''}`}
                              aria-labelledby={`registration-candidate-${index}`}
                            >
                              <div className="registration-candidate-heading">
                                <h4 id={`registration-candidate-${index}`}>제안 {index + 1}</h4>
                                <button
                                  type="button"
                                  className="registration-candidate-select"
                                  disabled={disabled || busy}
                                  aria-pressed={chosen}
                                  aria-label={
                                    chosen
                                      ? `제안 ${index + 1} 선택 해제`
                                      : `제안 ${index + 1}을 등록 캡션으로 선택`
                                  }
                                  onClick={() =>
                                    setCaption((current) =>
                                      current === candidate ? '' : candidate,
                                    )
                                  }
                                >
                                  {chosen ? '선택됨' : '선택'}
                                </button>
                              </div>
                              <p className="caption">{candidate}</p>
                            </article>
                          );
                        })}
                      </section>
                    )}
                  </div>
                  {candidates === null && (
                    <p className="registration-hint">
                      원본 캡션의 의미와 말투를 유지하며, 선택한 이미지만 보조 자료로 Codex에
                      전달합니다.
                    </p>
                  )}
                </>
              ) : (
                <p className="caption registration-saved-caption" aria-label="등록 캡션">
                  {draft?.caption || '캡션이 없습니다.'}
                </p>
              )}
            </div>
          </section>
          {!editing && draft && (
            <PostCommentSection
              post={post}
              editing={commentEditing}
              onEditingChange={setCommentEditing}
              disabled={disabled || busy || !!commentProblem}
              saving={commentSaving}
              problem={commentProblem}
              onSave={saveComment}
            />
          )}
          {error && (
            <p className="registration-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className={`registration-footer${!editing ? ' registration-view-footer' : ''}`}>
          <div className="registration-footer-left">
            {!editing && draft && (
              <>
                <button
                  type="button"
                  className="registration-delete-button"
                  disabled={disabled || busy || commentEditing}
                  onClick={onDelete}
                  aria-label="등록 게시글 삭제"
                  title="등록 게시글 삭제"
                >
                  <Icon name="trash" />
                </button>
                <span className="registration-footer-divider" aria-hidden="true" />
              </>
            )}
            <div className="registration-actions">
              <button type="button" disabled={busy} onClick={requestClose}>
                {editing ? '취소' : '닫기'}
              </button>
              {editing ? (
                <button
                  type="button"
                  className="primary"
                  onClick={() => void save()}
                  disabled={
                    disabled ||
                    busy ||
                    !mediaIds.length ||
                    unavailable > 0 ||
                    (!!revision && !registrationChanged(baseline, caption, mediaIds))
                  }
                >
                  {saving ? '저장 중…' : revision ? '변경 저장' : '등록'}
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={disabled || busy || commentEditing}
                  onClick={startEditing}
                >
                  <Icon name="edit" />
                  수정
                </button>
              )}
            </div>
          </div>
          {!editing && draft && (
            <div className="registration-actions registration-publish-actions">
              <button
                type="button"
                className={exporting ? 'is-exporting' : ''}
                disabled={disabled || busy || commentEditing || !!exportIssue}
                title={exportIssue ?? '등록 게시글 ZIP 다운로드'}
                aria-busy={exporting}
                onClick={onExport}
              >
                <Icon name={exporting ? 'refresh' : 'download'} />
                {exporting ? '다운로드 중…' : '다운로드'}
              </button>
              <button type="button" disabled title="API 업로드는 준비 중입니다.">
                <Icon name="upload" />
                API 업로드
              </button>
            </div>
          )}
        </footer>
      </div>
      {discard && (
        <section
          className="registration-discard"
          role="alertdialog"
          aria-labelledby="registration-discard-title"
          aria-describedby="registration-discard-description"
        >
          <h3 id="registration-discard-title">변경 내용을 버릴까요?</h3>
          <p id="registration-discard-description">
            {commentEditing
              ? '저장하지 않은 댓글 내용은 사라집니다.'
              : '저장하지 않은 미디어 선택과 캡션은 사라집니다.'}
          </p>
          <div className="registration-actions">
            <button type="button" ref={continueEditing} onClick={dismissDiscard}>
              계속 수정
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
