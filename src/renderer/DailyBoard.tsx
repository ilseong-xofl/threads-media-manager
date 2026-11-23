import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { DailyPersona, DailyPost, SaveDailyPersonaInput } from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import { Icon } from './Icon';
import { DailyPersonaDialog } from './DailyPersonaDialog';
import { DailyPostDialog } from './DailyPostDialog';
import { DailyRepliesDialog } from './DailyRepliesDialog';
import { ManagedThreadsActionDialog } from './ManagedThreadsActionDialog';
import { useManagedThreads } from './use-managed-threads';
import type { DailyState } from './use-daily';
import {
  dailyAccountName,
  dailyAccountRow,
  dailyAnswerBadges,
  dailyColumnCount,
  dailyDay,
  dailyInitial,
  dailyNoteLabel,
  dailyRangeLabel,
  dailySendBlock,
  dailyTime,
  dailyWindow,
  dailyWindowFor,
  groupDailyPosts,
} from './daily-model';
import './daily.css';
import './mobile-publications.css';
import './managed-threads.css';

const COLUMN_MIN_WIDTH = 300;
const COLUMN_GAP = 16;
const avatarColors = ['#5c5ed6', '#0f766e', '#b45309', '#be185d'];
const CANCEL_WARNING =
  '휴대폰이 이미 등록을 시도한 글입니다. 취소해도 Threads에 올라갔을 수 있으니 Threads 앱에서 확인하세요. 이미 보낸 요청은 취소되지 않습니다.';

type Dialog =
  | { kind: 'persona'; personaId: string | null }
  | { kind: 'post'; postId: string }
  | { kind: 'write'; personaId: string }
  | { kind: 'cancel'; postId: string }
  | { kind: 'send'; postId: string }
  | { kind: 'replies'; postId: string };

export function DailyBoard({
  daily,
  heading,
  serviceAvailable,
  onDialogOpenChange,
}: {
  daily: DailyState;
  serviceAvailable: boolean;
  /** The collection/daily mode tabs, shown where the page title would be. */
  heading: ReactNode;
  onDialogOpenChange(open: boolean): void;
}) {
  const accounts = useManagedThreads(serviceAvailable);
  const { personas, posts } = daily.view;
  const [start, setStart] = useState(0);
  const [columns, setColumns] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const board = useRef<HTMLDivElement>(null);
  const { refresh } = daily;
  const { synchronize } = accounts;
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
      void synchronize();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh, synchronize]);
  useLayoutEffect(() => {
    const element = board.current;
    if (!element) return;
    const measure = () =>
      setColumns(dailyColumnCount(element.clientWidth, COLUMN_MIN_WIDTH, COLUMN_GAP));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const shown = dailyWindow(start, personas.length, columns);
  const dialogPersona =
    dialog?.kind === 'persona' && dialog.personaId
      ? (personas.find((persona) => persona.id === dialog.personaId) ?? null)
      : null;
  const dialogPost =
    dialog?.kind === 'post' ||
    dialog?.kind === 'cancel' ||
    dialog?.kind === 'send' ||
    dialog?.kind === 'replies'
      ? (posts.find((post) => post.id === dialog.postId) ?? null)
      : null;
  const postPersona = personas.find(
    (persona) =>
      persona.id === (dialog?.kind === 'write' ? dialog.personaId : dialogPost?.personaId),
  );
  const closeDialog = () => setDialog(null);
  const closeReplies = () => {
    daily.closeReplies();
    setDialog(null);
  };
  let dialogElement: ReactNode = null;
  if (dialog?.kind === 'persona' && (dialog.personaId === null || dialogPersona)) {
    dialogElement = (
      <DailyPersonaDialog
        persona={dialogPersona}
        personas={personas}
        posts={posts}
        rows={accounts.accounts}
        accountsLoaded={accounts.loaded}
        busy={daily.busy}
        onSave={(input) => savePersona(input)}
        onDelete={() => daily.deletePersona(dialogPersona!.id)}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'post' && dialogPost?.state === 'draft' && postPersona) {
    dialogElement = (
      <DailyPostDialog
        post={dialogPost}
        persona={postPersona}
        busy={daily.busy}
        onSave={(text) => daily.savePost(dialogPost.id, text)}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'write' && postPersona) {
    dialogElement = (
      <DailyPostDialog
        post={null}
        persona={postPersona}
        busy={daily.busy}
        composing={daily.composing}
        onSave={(text, fromKorean) => daily.addPost(postPersona.id, text, fromKorean)}
        onClose={closeDialog}
      />
    );
  } else if (dialog?.kind === 'cancel' && dialogPost?.state === 'waiting') {
    dialogElement = (
      <ManagedThreadsActionDialog
        title="보내기 취소"
        busy={daily.busy}
        confirmation
        onClose={closeDialog}
      >
        <div className="managed-threads-confirm-copy">
          <p>{CANCEL_WARNING}</p>
        </div>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={daily.busy} onClick={closeDialog}>
            돌아가기
          </button>
          <button
            type="button"
            className="managed-threads-danger-primary"
            disabled={daily.busy}
            onClick={() =>
              void daily.cancel({ postId: dialogPost.id, abandon: true }).then(closeDialog)
            }
          >
            {daily.busy ? '취소하는 중…' : '보내기 취소'}
          </button>
        </div>
      </ManagedThreadsActionDialog>
    );
  } else if (dialog?.kind === 'send' && dialogPost?.state === 'draft' && postPersona) {
    // 2026-11-18, the user's call: a draft is not sent by one click; the account and text are
    // shown first, like the send dialog of a collected post.
    const row = dailyAccountRow(postPersona.accountId, accounts.accounts);
    dialogElement = (
      <ManagedThreadsActionDialog
        title="모바일로 보내기"
        busy={daily.busy}
        confirmation
        onClose={closeDialog}
      >
        <div className="mobile-publication-dialog-body">
          <p className="mobile-publication-account-field">
            <span className="mobile-publication-account-label">보낼 계정</span>
            <strong>
              {row ? dailyAccountName(row) : '계정 없음'} ({postPersona.name})
            </strong>
          </p>
          <p className="daily-send-text">{dialogPost.text}</p>
          <p>
            이 글을 휴대폰 대기로 보냅니다. 등록 기한은 7일이며, 실제 등록은 이 계정의 휴대폰에서
            합니다.
          </p>
        </div>
        <div className="threads-actions managed-threads-dialog-actions">
          <button type="button" disabled={daily.busy} onClick={closeDialog}>
            취소
          </button>
          <button
            type="button"
            className="primary"
            disabled={daily.busy}
            onClick={() => void daily.send(dialogPost.id).then(closeDialog)}
          >
            {daily.busy ? '보내는 중…' : '이 계정으로 보내기'}
          </button>
        </div>
      </ManagedThreadsActionDialog>
    );
  } else if (dialog?.kind === 'replies' && dialogPost?.state === 'published' && postPersona) {
    const row = dailyAccountRow(postPersona.accountId, accounts.accounts);
    dialogElement = (
      <DailyRepliesDialog
        post={dialogPost}
        persona={postPersona}
        daily={daily}
        account={row ? dailyAccountName(row) : '계정 없음'}
        sendBlock={dailySendBlock(postPersona, accounts.accounts, accounts.loaded)}
        onClose={closeReplies}
      />
    );
  }
  const dialogOpen = dialogElement !== null;
  useEffect(() => {
    onDialogOpenChange(dialogOpen);
  }, [dialogOpen, onDialogOpenChange]);
  useEffect(() => () => onDialogOpenChange(false), [onDialogOpenChange]);

  async function savePersona(input: SaveDailyPersonaInput) {
    const before = new Set(personas.map((persona) => persona.id));
    const saved = await daily.savePersona(input);
    if (saved && !input.personaId) {
      const next = daily.getSnapshot().view.personas;
      const index = next.findIndex((persona) => !before.has(persona.id));
      if (index >= 0) setStart(dailyWindowFor(index, start, next.length, columns));
    }
    return saved;
  }
  function openReplies(post: DailyPost) {
    setDialog({ kind: 'replies', postId: post.id });
    // A window whose replies could not be read closes; the toast says why.
    void daily.openReplies(post.id).then((read) => {
      if (!read)
        setDialog((open) => (open?.kind === 'replies' && open.postId === post.id ? null : open));
    });
  }
  function cancelSend(post: DailyPost) {
    if (post.started) setDialog({ kind: 'cancel', postId: post.id });
    else void daily.cancel({ postId: post.id });
  }

  return (
    <>
      <div className="daily-heading">
        <div className="daily-heading-copy">
          {heading}
          <p>페르소나마다 일상 글을 만들고 휴대폰으로 보내세요.</p>
        </div>
        <button
          type="button"
          className="primary daily-add-persona"
          disabled={!daily.loaded}
          onClick={() => setDialog({ kind: 'persona', personaId: null })}
        >
          <Icon name="plus" />
          페르소나
        </button>
      </div>
      {daily.view.unsyncedPersonas > 0 && (
        <p className="daily-sync-note" role="status">
          서버에서 확인하지 못한 페르소나가 {daily.view.unsyncedPersonas}개 있습니다. 휴대폰에는
          보이지 않을 수 있습니다.
        </p>
      )}
      {personas.length > 0 && (
        <div className="daily-strip-row">
          <button
            type="button"
            className="daily-arrow"
            aria-label="이전 페르소나"
            disabled={shown.start === 0}
            onClick={() => setStart(Math.max(0, shown.start - columns))}
          >
            <Icon name="left" />
          </button>
          <div className="daily-strip" role="group" aria-label="페르소나 목록">
            {personas.slice(0, shown.start).map((persona, index) => (
              <PersonaChip
                key={persona.id}
                persona={persona}
                daily={daily}
                onClick={() => setStart(dailyWindowFor(index, start, personas.length, columns))}
              />
            ))}
            <div className="daily-strip-shown">
              {personas.slice(shown.start, shown.end).map((persona, offset) => (
                <PersonaChip
                  key={persona.id}
                  persona={persona}
                  daily={daily}
                  color={avatarColors[(shown.start + offset) % avatarColors.length]}
                  shown
                  onClick={() => {}}
                />
              ))}
            </div>
            {personas.slice(shown.end).map((persona, offset) => (
              <PersonaChip
                key={persona.id}
                persona={persona}
                daily={daily}
                onClick={() =>
                  setStart(dailyWindowFor(shown.end + offset, start, personas.length, columns))
                }
              />
            ))}
          </div>
          <span className="daily-range" aria-live="polite">
            {dailyRangeLabel(shown.start, shown.end, personas.length)}
          </span>
          <button
            type="button"
            className="daily-arrow"
            aria-label="다음 페르소나"
            disabled={shown.end >= personas.length}
            onClick={() => setStart(shown.start + columns)}
          >
            <Icon name="right" />
          </button>
        </div>
      )}
      <div ref={board} className="daily-board">
        {personas.length > 0 ? (
          <div
            className="daily-columns"
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
          >
            {personas.slice(shown.start, shown.end).map((persona, offset) => (
              <PersonaColumn
                key={persona.id}
                persona={persona}
                color={avatarColors[(shown.start + offset) % avatarColors.length]}
                daily={daily}
                rows={accounts.accounts}
                accountsLoaded={accounts.loaded}
                onSettings={() => setDialog({ kind: 'persona', personaId: persona.id })}
                onWrite={() => setDialog({ kind: 'write', personaId: persona.id })}
                onEdit={(post) => setDialog({ kind: 'post', postId: post.id })}
                onSend={(post) => setDialog({ kind: 'send', postId: post.id })}
                onCancel={cancelSend}
                onReplies={openReplies}
              />
            ))}
          </div>
        ) : (
          <section className="empty welcome daily-empty">
            <Icon name="layers" />
            <h2>{daily.loaded ? '아직 페르소나가 없습니다' : '일상 정보를 불러오고 있습니다'}</h2>
            <p>페르소나를 만들고 계정을 연동하면 그 사람의 일상 글을 여기서 만들 수 있습니다.</p>
            <button
              type="button"
              className="primary"
              disabled={!daily.loaded}
              onClick={() => setDialog({ kind: 'persona', personaId: null })}
            >
              <Icon name="plus" />
              페르소나 만들기
            </button>
          </section>
        )}
      </div>
      {dialogElement}
    </>
  );
}

function PersonaChip({
  persona,
  daily,
  color,
  shown = false,
  onClick,
}: {
  persona: DailyPersona;
  daily: DailyState;
  color?: string;
  shown?: boolean;
  onClick(): void;
}) {
  const drafts = daily.view.posts.filter(
    (post) => post.personaId === persona.id && post.state === 'draft',
  ).length;
  const badge =
    daily.generatingPersonaId === persona.id ? '생성 중' : drafts > 0 ? `초안 ${drafts}` : null;
  return (
    <button
      type="button"
      className={`daily-chip ${shown ? 'is-shown' : ''}`}
      aria-current={shown ? 'true' : undefined}
      onClick={onClick}
    >
      <span className="daily-avatar is-small" style={color ? { background: color } : undefined}>
        {dailyInitial(persona.name)}
      </span>
      {persona.name}
      {badge && <span className="daily-chip-badge">{badge}</span>}
    </button>
  );
}

function PersonaColumn({
  persona,
  color,
  daily,
  rows,
  accountsLoaded,
  onSettings,
  onWrite,
  onEdit,
  onSend,
  onCancel,
  onReplies,
}: {
  persona: DailyPersona;
  color: string;
  daily: DailyState;
  rows: ManagedThreadsAccountRow[];
  accountsLoaded: boolean;
  onSettings(): void;
  onWrite(): void;
  onEdit(post: DailyPost): void;
  onSend(post: DailyPost): void;
  onCancel(post: DailyPost): void;
  onReplies(post: DailyPost): void;
}) {
  const groups = groupDailyPosts(daily.view.posts, persona.id);
  const generating = daily.generatingPersonaId === persona.id;
  // 2026-11-23: what is still to go out and what is on Threads are two tabs; drafts come first.
  const [tab, setTab] = useState<'drafts' | 'published'>('drafts');
  const drafts = groups.drafts.length;
  const draftsBefore = useRef(drafts);
  // A new draft, written or being written, is shown where it lands.
  useEffect(() => {
    if (generating || drafts > draftsBefore.current) setTab('drafts');
    draftsBefore.current = drafts;
  }, [generating, drafts]);
  const freshReplies = groups.published.reduce((sum, post) => sum + (post.replies?.fresh ?? 0), 0);
  // ChatGPT writes one thing at a time, and no post is written or edited by hand meanwhile.
  const { writing } = daily;
  const empty =
    !generating && groups.drafts.length + groups.waiting.length + groups.published.length === 0;
  const row = dailyAccountRow(persona.accountId, rows);
  const sendBlock = dailySendBlock(persona, rows, accountsLoaded);
  const summary = persona.description
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' · ');
  return (
    <section className="daily-column" aria-label={persona.name}>
      <div className="daily-column-head">
        <div className="daily-persona">
          <span className="daily-avatar" style={{ background: color }}>
            {dailyInitial(persona.name)}
          </span>
          <div className="daily-persona-name">
            <strong>{persona.name}</strong>
            <span>{row ? dailyAccountName(row) : accountsLoaded ? '연동 계정 없음' : ''}</span>
          </div>
          <button
            type="button"
            className="daily-icon-button"
            aria-label={`${persona.name} 설정`}
            onClick={onSettings}
          >
            <Icon name="more" />
          </button>
        </div>
        {summary && (
          <p className="daily-persona-summary" title={persona.description}>
            {summary}
          </p>
        )}
        <div className="daily-column-actions">
          <button
            type="button"
            className="daily-generate"
            disabled={!daily.loaded || daily.busy || writing}
            onClick={onWrite}
          >
            <Icon name="edit" />
            수동 등록
          </button>
          <button
            type="button"
            className={`daily-generate ${empty ? 'is-first' : ''}`}
            disabled={!daily.loaded || writing}
            onClick={() => void daily.generate(persona.id)}
          >
            {generating ? (
              '글 만드는 중…'
            ) : (
              <>
                <Icon name="sparkles" />
                {empty ? '첫 글 생성' : '글 생성'}
              </>
            )}
          </button>
        </div>
      </div>
      {empty ? (
        <div className="daily-column-empty">이 페르소나의 글이 여기에 쌓입니다.</div>
      ) : (
        <>
          <div className="daily-post-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'drafts'}
              className={tab === 'drafts' ? 'is-active' : ''}
              onClick={() => setTab('drafts')}
            >
              초안 {drafts}
              {groups.waiting.length > 0 && (
                <span className="daily-post-tab-note">대기 {groups.waiting.length}</span>
              )}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'published'}
              className={tab === 'published' ? 'is-active' : ''}
              onClick={() => setTab('published')}
            >
              등록 완료 {groups.published.length}
              {freshReplies > 0 && (
                <span className="daily-post-tab-fresh">새 댓글 {freshReplies}</span>
              )}
            </button>
          </div>
          <div className="daily-posts">
            {tab === 'drafts' && drafts + groups.waiting.length === 0 && !generating && (
              <div className="daily-column-empty">초안이 없습니다.</div>
            )}
            {tab === 'published' && groups.published.length === 0 && (
              <div className="daily-column-empty">등록 완료된 글이 없습니다.</div>
            )}
            {tab === 'drafts' && (groups.drafts.length > 0 || generating) && (
              <>
                {generating &&
                  [0, 1, 2].map((index) => (
                    <div key={index} className="daily-card-skeleton" aria-hidden="true">
                      <div />
                      <div />
                      <div />
                    </div>
                  ))}
                {groups.drafts.map((post) => (
                  <article key={post.id} className="daily-card">
                    <button
                      type="button"
                      className="daily-card-text"
                      aria-label="초안 수정"
                      disabled={daily.busy || writing}
                      onClick={() => onEdit(post)}
                    >
                      {post.text}
                    </button>
                    {post.translation ? (
                      <p className="daily-card-translation">{post.translation}</p>
                    ) : daily.translatingPostId === post.id ? (
                      <p className="daily-card-translation">한국어 뜻 만드는 중…</p>
                    ) : (
                      persona.language !== 'ko' && (
                        <button
                          type="button"
                          className="daily-card-translate"
                          disabled={!daily.loaded || writing}
                          onClick={() => void daily.translate(post.id)}
                        >
                          한국어 뜻 보기
                        </button>
                      )
                    )}
                    <div className="daily-card-footer">
                      <span>{dailyTime(post.createdAt)} 생성</span>
                      <div className="daily-card-actions">
                        <button
                          type="button"
                          className="daily-icon-button"
                          aria-label="초안 삭제"
                          disabled={daily.busy}
                          onClick={() => void daily.deletePost(post.id)}
                        >
                          <Icon name="trash" />
                        </button>
                        <button
                          type="button"
                          className="primary daily-card-send"
                          disabled={daily.busy || !!sendBlock}
                          title={sendBlock ?? undefined}
                          onClick={() => onSend(post)}
                        >
                          모바일로 보내기
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </>
            )}
            {tab === 'drafts' && groups.waiting.length > 0 && (
              <>
                <div className="daily-group-title">휴대폰 대기 {groups.waiting.length}</div>
                {groups.waiting.map((post) => {
                  const note = dailyNoteLabel(post.note);
                  return (
                    <article key={post.id} className="daily-card is-waiting">
                      <p className="daily-card-body">{post.text}</p>
                      {post.translation && (
                        <p className="daily-card-translation">{post.translation}</p>
                      )}
                      <div className="daily-card-meta">
                        {post.sentAt && <span>{dailyTime(post.sentAt)} 보냄</span>}
                        {note && <span className="daily-card-note">{note}</span>}
                      </div>
                      <div className="daily-card-actions is-end">
                        <button type="button" disabled={daily.busy} onClick={() => onCancel(post)}>
                          보내기 취소
                        </button>
                        {post.note === 'unconfirmed' && (
                          <button
                            type="button"
                            className="primary daily-card-send"
                            disabled={daily.busy || !!sendBlock}
                            title={sendBlock ?? undefined}
                            onClick={() => void daily.send(post.id)}
                          >
                            다시 보내기
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </>
            )}
            {tab === 'published' && groups.published.length > 0 && (
              <>
                {groups.published.map((post) => (
                  <article key={post.id} className="daily-card is-published">
                    <p className="daily-card-body">{post.text}</p>
                    {post.translation && (
                      <p className="daily-card-translation">{post.translation}</p>
                    )}
                    <div className="daily-card-meta">
                      <span>{post.sentAt ? `${dailyDay(post.sentAt)} 보냄` : '등록 완료'}</span>
                      {post.replies &&
                        (post.replies.count > 0 ? (
                          <>
                            <span className="daily-card-replies-time">
                              {dailyTime(post.replies.fetchedAt)} 조회
                            </span>
                            {/* New replies take the badge's place until the window is opened. */}
                            <button
                              type="button"
                              className={`daily-card-replies ${post.replies.fresh > 0 ? 'is-fresh' : ''}`}
                              onClick={() => onReplies(post)}
                            >
                              {post.replies.fresh > 0
                                ? `새 댓글 ${post.replies.fresh}`
                                : `댓글 ${post.replies.count}`}
                            </button>
                          </>
                        ) : (
                          <span className="daily-card-replies-none">
                            댓글 없음 · {dailyTime(post.replies.fetchedAt)} 조회
                          </span>
                        ))}
                      {post.replies &&
                        dailyAnswerBadges(post.replies).map((badge) => (
                          <span key={badge} className="daily-card-note">
                            {badge}
                          </span>
                        ))}
                    </div>
                  </article>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
