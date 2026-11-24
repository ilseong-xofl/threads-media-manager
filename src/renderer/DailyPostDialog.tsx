import { useEffect, useId, useRef, useState } from 'react';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_KOREAN_DRAFT_LIMIT,
  DAILY_MEDIA_LIMIT,
  DAILY_TEXT_LIMIT,
  dailyTextLength,
  type DailyMedia,
  type DailyPersona,
  type DailyPost,
  type DailyReply,
} from '../shared/daily';
import type { Ment } from '../shared/ments';
import { DailyMediaField } from './DailyMediaField';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import { MentPicker } from './MentPicker';
import { useMentCatalog } from './use-ments';
import './managed-threads.css';

const languageNames: Record<CaptionLanguage, string> = {
  ko: '한국어',
  ja: '일본어',
  en: '영어',
};

/**
 * Edits a draft, or with no `post` writes a new one for the persona by hand. With `replyTo` it
 * does the same for the persona's answer to that reply (2026-11-21).
 */
export function DailyPostDialog({
  post,
  persona,
  busy,
  composing = false,
  replyTo,
  mediaReady = false,
  onSave,
  onClose,
}: {
  post:
    (Pick<DailyPost, 'text' | 'translation'> & Partial<Pick<DailyPost, 'topic' | 'media'>>) | null;
  persona: DailyPersona;
  replyTo?: DailyReply;
  /** A work folder is set, so a post can take images and videos (2026-11-24). */
  mediaReady?: boolean;
  busy: boolean;
  /** The Korean draft is being written in the persona's language. */
  composing?: boolean;
  /**
   * `fromKorean`: the text is Korean and the persona posts in another language. `topic` is the
   * topic field as typed (a post only). `media` are the attachment ids in posting order, the
   * ones added coming from `selectionId` (a post only).
   */
  onSave(
    text: string,
    fromKorean: boolean,
    topic: string,
    media: string[],
    selectionId: string | null,
  ): Promise<boolean>;
  onClose(): void;
}) {
  const id = useId();
  const [text, setText] = useState(post?.text ?? '');
  const [topic, setTopic] = useState(post?.topic ?? '');
  const [language, setLanguage] = useState<CaptionLanguage>(persona.language);
  const [media, setMedia] = useState<DailyMedia[]>(post?.media ?? []);
  const [selectionId, setSelectionId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** Ids copied into the selection in this dialog, as opposed to those the draft had. */
  const added = useRef(new Set<string>());
  const selection = useRef<string | null>(null);
  const kept = useRef(false);
  // Closing without saving (취소, X, Esc) drops what this dialog added; a saved post keeps it.
  useEffect(
    () => () => {
      if (selection.current && !kept.current)
        void window.threadsMedia
          .discardDailyMedia({ selectionId: selection.current })
          .catch(() => undefined);
    },
    [],
  );
  // A post's topic is set when it is written by hand and while its draft is edited; an answer
  // has none.
  const editsTopic = !replyTo;
  const fromKorean = !post && persona.language !== 'ko' && language === 'ko';
  // A Korean draft grows when it is written in some languages, so it gets a shorter limit.
  const limit = fromKorean ? DAILY_KOREAN_DRAFT_LIMIT[persona.language] : DAILY_TEXT_LIMIT;
  const length = dailyTextLength(text);
  // With an attachment the text may be empty (2026-11-24).
  const valid =
    (media.length > 0 || dailyTextLength(text.trim()) >= 1) &&
    length <= limit &&
    media.length <= DAILY_MEDIA_LIMIT;
  const personaLanguage = languageNames[persona.language];
  const working = busy || composing || importing;
  const kind = replyTo ? '답글' : '글';
  // A post (not an answer) can take a saved ment as its body (2026-11-24).
  const catalog = useMentCatalog(!replyTo);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [replacing, setReplacing] = useState<Ment | null>(null);
  function fill(ment: Ment) {
    setText(ment.body);
    setPickedId(ment.id);
  }
  /** Fills the body with the ment, asking first when it would replace other text. */
  function pick(ment: Ment) {
    if (text.trim() && text.trim() !== ment.body.trim()) setReplacing(ment);
    else fill(ment);
  }
  return (
    <ManagedThreadsActionDialog
      title={replyTo ? (post ? '답글 수정' : '답글 쓰기') : post ? '초안 수정' : '수동 등록'}
      // Files being copied do not hold the dialog: closing it stops and drops them.
      busy={busy || composing}
      onClose={onClose}
      className={replyTo ? undefined : 'daily-post-dialog'}
    >
      <form
        className="daily-post-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (working || !valid) return;
          const ids = media.map((file) => file.id);
          // A selection whose files were all left out is dropped on close, not sent.
          const used = ids.some((mediaId) => added.current.has(mediaId)) ? selectionId : null;
          void onSave(text, fromKorean, topic, ids, used).then((saved) => {
            if (!saved) return;
            kept.current = used !== null;
            onClose();
          });
        }}
      >
        {/* The fields; in 수동 등록·초안 수정 only they scroll, above the fixed actions. */}
        <div className="daily-form">
          {!replyTo && (
            <DailyMediaField
              media={media}
              selectionId={selectionId}
              ready={mediaReady}
              disabled={busy || composing}
              onChange={setMedia}
              onAdd={(id, files) => {
                selection.current = id;
                setSelectionId(id);
                files.forEach((file) => added.current.add(file.id));
                setMedia((shown) => [...shown, ...files]);
              }}
              onImporting={setImporting}
            />
          )}
          {replyTo && (
            <div className="daily-answer-to">
              <strong>@{replyTo.username}</strong>
              {replyTo.text && <p className="daily-card-body">{replyTo.text}</p>}
              {replyTo.translation && (
                <p className="daily-card-translation">{replyTo.translation}</p>
              )}
            </div>
          )}
          {!post && persona.language !== 'ko' && (
            <>
              <label htmlFor={`${id}-language`}>작성 언어</label>
              <select
                id={`${id}-language`}
                value={language}
                disabled={working}
                onChange={(event) => setLanguage(event.target.value as CaptionLanguage)}
              >
                <option value={persona.language}>{personaLanguage}</option>
                <option value="ko">한국어</option>
              </select>
              <p className="daily-form-note">
                {fromKorean
                  ? `한국어로 쓰면 ${personaLanguage} ${kind}로 바꿔 초안에 넣습니다. 쓴 내용은 한국어 뜻으로 함께 보입니다.${
                      replyTo ? ' 바꿀 때 댓글 내용은 ChatGPT에 보내지 않습니다.' : ''
                    }${
                      limit < DAILY_TEXT_LIMIT
                        ? ` ${personaLanguage}로 바꾸면 길이가 두 배쯤 늘어 ${limit}자까지 쓸 수 있습니다.`
                        : ''
                    }`
                  : `쓴 그대로 초안에 넣${replyTo ? '습니다' : '고 한국어 뜻을 만듭니다'}. ${personaLanguage} 작문이 어렵다면 한국어를 고르세요.`}
              </p>
            </>
          )}
          {editsTopic && (
            <>
              <label htmlFor={`${id}-topic`}>토픽</label>
              <input
                id={`${id}-topic`}
                type="text"
                value={topic}
                disabled={working}
                placeholder="선택 · 예: Mom Threads"
                onChange={(event) => setTopic(event.target.value)}
              />
            </>
          )}
          {!replyTo && catalog && catalog.brands.length > 0 && (
            <MentPicker catalog={catalog} mentId={pickedId} disabled={working} onPick={pick} />
          )}
          <label htmlFor={`${id}-text`}>본문</label>
          <textarea
            id={`${id}-text`}
            value={text}
            rows={8}
            disabled={working}
            aria-describedby={`${id}-count`}
            onChange={(event) => setText(event.target.value)}
          />
          <p id={`${id}-count`} className={`daily-form-count ${length > limit ? 'is-over' : ''}`}>
            {length} / {limit}
          </p>
          {post?.translation && (
            <>
              <p className="daily-card-translation">{post.translation}</p>
              <p className="daily-form-note">
                {replyTo
                  ? '본문을 고쳐 저장하면 한국어 뜻은 지워집니다.'
                  : '본문을 고쳐 저장하면 한국어 뜻을 다시 만듭니다.'}
              </p>
            </>
          )}
        </div>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={busy || composing} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={working || !valid}>
            {composing ? `${personaLanguage}로 바꾸는 중…` : busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
      {replacing && (
        <ManagedThreadsActionDialog
          title="본문 바꾸기"
          busy={false}
          confirmation
          onClose={() => setReplacing(null)}
        >
          <div className="managed-threads-confirm-copy">
            <p>본문을 &apos;{replacing.title}&apos; 멘트로 바꿀까요? 지금 쓴 내용은 사라집니다.</p>
          </div>
          <div className="threads-actions managed-threads-dialog-actions">
            {/* [취소] keeps the body and the ment it came from as they are. */}
            <button type="button" onClick={() => setReplacing(null)}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              onClick={() => {
                fill(replacing);
                setReplacing(null);
              }}
            >
              확인
            </button>
          </div>
        </ManagedThreadsActionDialog>
      )}
    </ManagedThreadsActionDialog>
  );
}
