import { Fragment, useState } from 'react';
import type { DailyAnswer, DailyPersona, DailyPost, DailyReply } from '../shared/daily';
import { DailyPostDialog } from './DailyPostDialog';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import type { DailyState } from './use-daily';
import {
  dailyAnswerDrafts,
  dailyAnswerNote,
  dailyReplyMedia,
  dailyReplyRows,
  dailyRepliesTranslatable,
  dailyTime,
} from './daily-model';
import './managed-threads.css';

type Sub = { kind: 'write'; reply: DailyReply; answer: DailyAnswer | null } | { kind: 'send' };

/**
 * The replies the phone fetched for a published post, and the persona's answers to them
 * (2026-11-21): written here, posted by the phone.
 */
export function DailyRepliesDialog({
  post,
  persona,
  daily,
  account,
  sendBlock,
  onClose,
}: {
  post: DailyPost;
  persona: DailyPersona;
  daily: DailyState;
  /** The account the answers go out from, as the board names it. */
  account: string;
  /** Why answers cannot be sent right now, or null. */
  sendBlock: string | null;
  onClose(): void;
}) {
  const [sub, setSub] = useState<Sub | null>(null);
  const thread = daily.replies?.postId === post.id ? daily.replies : null;
  const translating = daily.translatingRepliesPostId === post.id;
  const fetchedAt = thread ? thread.fetchedAt : (post.replies?.fetchedAt ?? null);
  const drafts = thread ? dailyAnswerDrafts(thread) : [];
  // ChatGPT writes one thing at a time, and nothing is changed by hand meanwhile.
  const locked = !daily.loaded || daily.busy || daily.writing;
  const closeSub = () => setSub(null);
  function answerCell(reply: DailyReply) {
    const answer = thread?.answers.find((item) => item.replyThreadsId === reply.threadsId);
    if (!answer)
      return (
        <div className="daily-answer is-empty">
          <button
            type="button"
            className="daily-card-translate"
            disabled={locked}
            onClick={() => setSub({ kind: 'write', reply, answer: null })}
          >
            답글 쓰기
          </button>
        </div>
      );
    const note = dailyAnswerNote(answer);
    return (
      <div className={`daily-answer is-${answer.state}`}>
        <p className="daily-answer-label">
          {answer.state === 'draft' ? '답글 초안' : '내 답글'}
          {note && <span className="daily-card-note">{note}</span>}
        </p>
        <p className="daily-card-body">{answer.text}</p>
        {answer.translation && <p className="daily-card-translation">{answer.translation}</p>}
        {answer.postedBefore && (
          <p className="daily-form-note">
            이미 올라간 답글이 있습니다. 취소했던 답글을 휴대폰이 올렸습니다.
          </p>
        )}
        <div className="daily-card-actions is-end">
          {answer.state === 'draft' ? (
            <>
              <button
                type="button"
                disabled={locked}
                onClick={() => void daily.deleteAnswer(post.id, answer.id)}
              >
                삭제
              </button>
              <button
                type="button"
                disabled={locked}
                onClick={() => setSub({ kind: 'write', reply, answer })}
              >
                수정
              </button>
            </>
          ) : (
            answer.state !== 'unknown' && (
              <>
                <button
                  type="button"
                  disabled={locked}
                  onClick={() => void daily.cancelAnswer(post.id, answer.id)}
                >
                  보내기 취소
                </button>
                {answer.state === 'unconfirmed' && (
                  <button
                    type="button"
                    className="primary"
                    disabled={locked || !!sendBlock}
                    title={sendBlock ?? undefined}
                    onClick={() => void daily.sendAnswers(post.id, [answer.id])}
                  >
                    다시 보내기
                  </button>
                )}
              </>
            )
          )}
        </div>
      </div>
    );
  }
  let subElement = null;
  if (sub?.kind === 'write')
    subElement = (
      <DailyPostDialog
        post={sub.answer}
        persona={persona}
        replyTo={sub.reply}
        busy={daily.busy}
        composing={daily.composing}
        onSave={(text, fromKorean) =>
          sub.answer
            ? daily.saveAnswer(post.id, sub.answer.id, text)
            : daily.addAnswer(post.id, sub.reply.threadsId, text, fromKorean)
        }
        onClose={closeSub}
      />
    );
  else if (sub?.kind === 'send' && drafts.length > 0)
    // Like a post, answers are not sent by one click: the account goes first.
    subElement = (
      <ManagedThreadsActionDialog
        title="모바일로 보내기"
        busy={daily.busy}
        confirmation
        onClose={closeSub}
      >
        <div className="mobile-publication-dialog-body">
          <p className="mobile-publication-account-field">
            <span className="mobile-publication-account-label">보낼 계정</span>
            <strong>
              {account} ({persona.name})
            </strong>
          </p>
          <p>
            답글 {drafts.length}개를 휴대폰 대기로 보냅니다. 휴대폰에서 이 글을 열어 하나씩
            올립니다.
          </p>
        </div>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={daily.busy} onClick={closeSub}>
            취소
          </button>
          <button
            type="button"
            className="primary"
            disabled={daily.busy}
            onClick={() =>
              void daily
                .sendAnswers(
                  post.id,
                  drafts.map((answer) => answer.id),
                )
                .then(closeSub)
            }
          >
            {daily.busy ? '보내는 중…' : '이 계정으로 보내기'}
          </button>
        </div>
      </ManagedThreadsActionDialog>
    );
  return (
    <ManagedThreadsActionDialog title="댓글" busy={translating || daily.busy} onClose={onClose}>
      <div className="daily-replies">
        <div className="daily-replies-post">
          <p className="daily-card-body">{post.text}</p>
          {post.translation && <p className="daily-card-translation">{post.translation}</p>}
          <p className="daily-form-note">
            {fetchedAt ? `${dailyTime(fetchedAt)} 조회 · ` : ''}휴대폰에서 [댓글 가져오기]를 누르면
            새 댓글이 들어옵니다.
          </p>
        </div>
        <div className="daily-replies-list">
          {!thread ? (
            <p className="daily-replies-empty">댓글을 불러오고 있습니다.</p>
          ) : thread.replies.length === 0 ? (
            <p className="daily-replies-empty">가져온 댓글이 없습니다.</p>
          ) : (
            dailyReplyRows(thread).map(({ reply, nested, orphan, to, divider, fresh }) => {
              const media = dailyReplyMedia(reply.mediaType);
              return (
                <Fragment key={reply.threadsId}>
                  {divider && (
                    <div className="daily-replies-divider" role="separator">
                      <span>이전 댓글</span>
                    </div>
                  )}
                  <article className={`daily-reply ${nested ? 'is-nested' : ''}`}>
                    <div className="daily-reply-head">
                      <strong>{reply.fromAnswer ? account : `@${reply.username}`}</strong>
                      <span>{dailyTime(reply.postedAt)}</span>
                      {orphan && <span className="daily-reply-tag">대댓글</span>}
                      {fresh && <span className="daily-reply-tag is-fresh">새 댓글</span>}
                      {reply.ownedByMe && <span className="daily-reply-tag is-mine">내 답글</span>}
                      {persona.language !== 'ko' &&
                        !reply.ownedByMe &&
                        reply.text.trim() !== '' && (
                          <button
                            type="button"
                            className="daily-reply-translate"
                            disabled={reply.translation !== null || !daily.loaded || daily.writing}
                            onClick={() => void daily.translateReplies(post.id, reply.threadsId)}
                          >
                            번역
                          </button>
                        )}
                    </div>
                    {to && <p className="daily-reply-to">↳ @{to}에게</p>}
                    {(reply.text || media) && (
                      <p className="daily-card-body">
                        {reply.text}
                        {media && (
                          <>
                            {reply.text ? ' ' : ''}
                            <span className="daily-reply-media">{media}</span>
                            {reply.hasLink && (
                              <>
                                {' '}
                                <button
                                  type="button"
                                  className="daily-card-translate"
                                  onClick={() => void daily.openReplyLink(post.id, reply.threadsId)}
                                >
                                  Threads에서 보기
                                </button>
                              </>
                            )}
                          </>
                        )}
                      </p>
                    )}
                    {reply.translation && (
                      <p className="daily-card-translation">{reply.translation}</p>
                    )}
                    {!reply.ownedByMe && answerCell(reply)}
                  </article>
                </Fragment>
              );
            })
          )}
        </div>
        <div className="threads-actions managed-threads-dialog-actions">
          {thread && dailyRepliesTranslatable(thread, persona.language) && (
            <button
              type="button"
              disabled={!daily.loaded || daily.writing}
              onClick={() => void daily.translateReplies(post.id)}
            >
              {translating ? '번역 중…' : '전체 번역'}
            </button>
          )}
          {drafts.length > 0 && (
            <button
              type="button"
              className="primary"
              disabled={locked || !!sendBlock}
              title={sendBlock ?? undefined}
              onClick={() => setSub({ kind: 'send' })}
            >
              모바일로 보내기 ({drafts.length}개)
            </button>
          )}
          <button
            type="button"
            className={drafts.length > 0 ? undefined : 'primary'}
            disabled={translating || daily.busy}
            onClick={onClose}
          >
            닫기
          </button>
        </div>
      </div>
      {subElement}
    </ManagedThreadsActionDialog>
  );
}
