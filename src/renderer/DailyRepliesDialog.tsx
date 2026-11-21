import type { DailyPersona, DailyPost } from '../shared/daily';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import type { DailyState } from './use-daily';
import {
  dailyReplyMedia,
  dailyReplyRows,
  dailyRepliesTranslatable,
  dailyTime,
} from './daily-model';
import './managed-threads.css';

/** The replies the phone fetched for a published post (2026-11-21). Reading only. */
export function DailyRepliesDialog({
  post,
  persona,
  daily,
  onClose,
}: {
  post: DailyPost;
  persona: DailyPersona;
  daily: DailyState;
  onClose(): void;
}) {
  const thread = daily.replies?.postId === post.id ? daily.replies : null;
  const translating = daily.translatingRepliesPostId === post.id;
  const fetchedAt = thread ? thread.fetchedAt : (post.replies?.fetchedAt ?? null);
  return (
    <ManagedThreadsActionDialog title="댓글" busy={translating} onClose={onClose}>
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
            dailyReplyRows(thread).map(({ reply, nested, orphan, to }) => {
              const media = dailyReplyMedia(reply.mediaType);
              return (
                <article
                  key={reply.threadsId}
                  className={`daily-reply ${nested ? 'is-nested' : ''}`}
                >
                  <div className="daily-reply-head">
                    <strong>@{reply.username}</strong>
                    <span>{dailyTime(reply.postedAt)}</span>
                    {orphan && <span className="daily-reply-tag">대댓글</span>}
                    {reply.ownedByMe && <span className="daily-reply-tag is-mine">내 답글</span>}
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
                </article>
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
              {translating ? '한국어 뜻 만드는 중…' : '한국어 뜻 보기'}
            </button>
          )}
          <button type="button" className="primary" disabled={translating} onClick={onClose}>
            닫기
          </button>
        </div>
      </div>
    </ManagedThreadsActionDialog>
  );
}
