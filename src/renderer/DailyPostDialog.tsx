import { useId, useState } from 'react';
import type { CaptionLanguage } from '../shared/contracts';
import {
  DAILY_KOREAN_DRAFT_LIMIT,
  DAILY_TEXT_LIMIT,
  dailyTextLength,
  type DailyPersona,
  type DailyPost,
  type DailyReply,
} from '../shared/daily';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
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
  onSave,
  onClose,
}: {
  post: Pick<DailyPost, 'text' | 'translation'> | null;
  persona: DailyPersona;
  replyTo?: DailyReply;
  busy: boolean;
  /** The Korean draft is being written in the persona's language. */
  composing?: boolean;
  /** `fromKorean`: the text is Korean and the persona posts in another language. */
  onSave(text: string, fromKorean: boolean): Promise<boolean>;
  onClose(): void;
}) {
  const id = useId();
  const [text, setText] = useState(post?.text ?? '');
  const [language, setLanguage] = useState<CaptionLanguage>(persona.language);
  const fromKorean = !post && persona.language !== 'ko' && language === 'ko';
  // A Korean draft grows when it is written in some languages, so it gets a shorter limit.
  const limit = fromKorean ? DAILY_KOREAN_DRAFT_LIMIT[persona.language] : DAILY_TEXT_LIMIT;
  const length = dailyTextLength(text);
  const valid = dailyTextLength(text.trim()) >= 1 && length <= limit;
  const personaLanguage = languageNames[persona.language];
  const working = busy || composing;
  const kind = replyTo ? '답글' : '글';
  return (
    <ManagedThreadsActionDialog
      title={replyTo ? (post ? '답글 수정' : '답글 쓰기') : post ? '초안 수정' : '수동 등록'}
      busy={working}
      onClose={onClose}
    >
      <form
        className="daily-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (working || !valid) return;
          void onSave(text, fromKorean).then((saved) => {
            if (saved) onClose();
          });
        }}
      >
        {replyTo && (
          <div className="daily-answer-to">
            <strong>@{replyTo.username}</strong>
            {replyTo.text && <p className="daily-card-body">{replyTo.text}</p>}
            {replyTo.translation && <p className="daily-card-translation">{replyTo.translation}</p>}
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
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={working} onClick={onClose}>
            취소
          </button>
          <button type="submit" className="primary" disabled={working || !valid}>
            {composing ? `${personaLanguage}로 바꾸는 중…` : busy ? '저장 중…' : '저장'}
          </button>
        </div>
      </form>
    </ManagedThreadsActionDialog>
  );
}
