import type { CaptionLanguage } from '../shared/contracts';
import type {
  DailyAnswer,
  DailyPersona,
  DailyPost,
  DailyReply,
  DailyReplySummary,
  DailyReplyThread,
  DailyView,
  DailyWaitingNote,
} from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import { mobileAccountChoices } from './mobile-publication-model';

export interface DailyPostGroups {
  drafts: DailyPost[];
  waiting: DailyPost[];
  published: DailyPost[];
}

const time = (value: string | null) => (value ? Date.parse(value) || 0 : 0);
const newestFirst = (key: (post: DailyPost) => number) => (a: DailyPost, b: DailyPost) =>
  key(b) - key(a);

/** One persona's posts: drafts, then posts waiting on the phone, then published ones. */
export function groupDailyPosts(posts: DailyPost[], personaId: string): DailyPostGroups {
  const own = posts.filter((post) => post.personaId === personaId);
  return {
    drafts: own
      .filter((post) => post.state === 'draft')
      .sort(newestFirst((post) => time(post.createdAt))),
    waiting: own
      .filter((post) => post.state === 'waiting')
      .sort(newestFirst((post) => time(post.sentAt ?? post.createdAt))),
    published: own
      .filter((post) => post.state === 'published')
      .sort(newestFirst((post) => time(post.sentAt ?? post.createdAt))),
  };
}

export function dailyAccountRow(accountId: string, rows: ManagedThreadsAccountRow[]) {
  return rows.find((row) => row.account?.id === accountId) ?? null;
}

export const dailyAccountName = (row: ManagedThreadsAccountRow) =>
  `@${row.label.replace(/^@/, '')}`;

/** Accounts a persona may be bound to: usable and not taken by another persona. */
export function dailyAccountChoices(
  rows: ManagedThreadsAccountRow[],
  personas: DailyPersona[],
  personaId?: string,
) {
  const taken = new Set(
    personas.filter((persona) => persona.id !== personaId).map((persona) => persona.accountId),
  );
  return mobileAccountChoices(rows).filter((row) => !taken.has(row.account!.id));
}

/** The account may change only while the persona has no posts, or after its account was removed. */
export function dailyAccountLocked(
  persona: DailyPersona,
  posts: DailyPost[],
  rows: ManagedThreadsAccountRow[],
) {
  return (
    posts.some((post) => post.personaId === persona.id) &&
    dailyAccountRow(persona.accountId, rows) !== null
  );
}

/** Why a persona's drafts cannot be sent to the phone right now, or null when they can. */
export function dailySendBlock(
  persona: DailyPersona,
  rows: ManagedThreadsAccountRow[],
  accountsLoaded: boolean,
) {
  if (!accountsLoaded) return '계정 목록을 확인하고 있습니다.';
  const row = dailyAccountRow(persona.accountId, rows);
  if (!row) return '연동 계정이 계정 관리에 없습니다. 페르소나 설정에서 다른 계정을 연동하세요.';
  if (row.pendingAction) return '계정 관리에서 이 계정의 갱신 재시도를 마쳐야 보낼 수 있습니다.';
  return null;
}

export function dailyNoteLabel(note: DailyWaitingNote | null) {
  switch (note) {
    case 'unconfirmed':
      return '전송 확인 필요';
    case 'check_phone':
      return '휴대폰에서 확인 필요';
    case 'failed':
      return '등록 실패';
    case 'expired':
      return '기한 지남';
    default:
      return null;
  }
}

/** How many persona columns fit; never fewer than one. */
export function dailyColumnCount(width: number, minWidth = 300, gap = 16) {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minWidth + gap)));
}

/** The shown slice of personas. The last page is filled from the end instead of left short. */
export function dailyWindow(start: number, total: number, columns: number) {
  const first = Math.max(0, Math.min(start, total - columns));
  return { start: first, end: Math.min(total, first + columns) };
}

/** Keeps the current slice when the persona is already shown; otherwise starts at it. */
export function dailyWindowFor(index: number, start: number, total: number, columns: number) {
  const current = dailyWindow(start, total, columns);
  if (index >= current.start && index < current.end) return current.start;
  return dailyWindow(index, total, columns).start;
}

export function dailyRangeLabel(start: number, end: number, total: number) {
  return end - start > 1 ? `${start + 1}–${end} / ${total}` : `${start + 1} / ${total}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** "오늘 14:20" today, otherwise "11. 15. 14:20". */
export function dailyTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === now.toDateString()
    ? `오늘 ${clock}`
    : `${date.getMonth() + 1}. ${date.getDate()}. ${clock}`;
}

export function dailyDay(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${date.getMonth() + 1}. ${date.getDate()}.`;
}

/** A post in another language whose Korean rendering is missing: edited, or made before them. */
export function dailyNeedsTranslation(view: DailyView, postId: string) {
  const post = view.posts.find((item) => item.id === postId);
  const persona = post && view.personas.find((item) => item.id === post.personaId);
  return (
    !!persona && persona.language !== 'ko' && post.translation === null && post.text.trim() !== ''
  );
}

/** One line of the replies window. */
export interface DailyReplyRow {
  reply: DailyReply;
  /** Shown indented under the reply to the post it belongs to. */
  nested: boolean;
  /** At the top level although it answers a reply that was not fetched. */
  orphan: boolean;
  /** Whose reply a nested one answers, when that is not the reply it is shown under. */
  to: string | null;
  /** The first reply seen before, with newer ones above it: the line between them goes here. */
  divider: boolean;
  /** Someone's new reply under a reply seen before, which the line cannot show: it gets a tag. */
  fresh: boolean;
}

/**
 * The order of the replies window (2026-11-21): replies to the post newest first, each followed
 * by every reply under it, oldest first and indented once. A reply whose parent was not fetched
 * (only the newest replies are) stands at the top level, marked as a reply to a reply.
 */
export function dailyReplyRows(thread: DailyReplyThread): DailyReplyRow[] {
  const byId = new Map(thread.replies.map((reply) => [reply.threadsId, reply]));
  /** The top-level reply this one is shown under; itself when it is at the top level. */
  const head = (reply: DailyReply) => {
    const seen = new Set<string>();
    let current = reply;
    while (current.parentThreadsId !== thread.rootThreadsId && !seen.has(current.threadsId)) {
      const parent = byId.get(current.parentThreadsId);
      if (!parent) break;
      seen.add(current.threadsId);
      current = parent;
    }
    return current;
  };
  const posted = (reply: DailyReply) => Date.parse(reply.postedAt) || 0;
  const heads = new Map(thread.replies.map((reply) => [reply.threadsId, head(reply)]));
  const tops = thread.replies
    .filter((reply) => heads.get(reply.threadsId) === reply)
    .sort((a, b) => posted(b) - posted(a));
  // Newest first, so the new ones stand together at the top (2026-11-23).
  const firstSeen = tops.some((top) => top.fresh) ? tops.find((top) => !top.fresh) : undefined;
  return tops.flatMap((top) => [
    {
      reply: top,
      nested: false,
      orphan: top.parentThreadsId !== thread.rootThreadsId,
      to: null,
      divider: top === firstSeen,
      fresh: false,
    },
    ...thread.replies
      .filter((reply) => reply !== top && heads.get(reply.threadsId) === top)
      .sort((a, b) => posted(a) - posted(b))
      .map((reply) => ({
        reply,
        nested: true,
        orphan: false,
        to:
          reply.parentThreadsId === top.threadsId
            ? null
            : (byId.get(reply.parentThreadsId)?.username ?? null),
        divider: false,
        fresh: !!reply.fresh && !reply.ownedByMe && !top.fresh,
      })),
  ]);
}

/** What a reply carries besides text. A carousel may mix both and is named as images. */
export function dailyReplyMedia(mediaType: string) {
  if (mediaType === 'IMAGE' || mediaType === 'CAROUSEL_ALBUM') return '[이미지]';
  if (mediaType === 'VIDEO') return '[영상]';
  return null;
}

/** [한국어 뜻 보기] is offered while another person's reply with text has no rendering. */
export function dailyRepliesTranslatable(thread: DailyReplyThread, language: CaptionLanguage) {
  return (
    language !== 'ko' &&
    thread.replies.some(
      (reply) => !reply.ownedByMe && reply.text.trim() !== '' && reply.translation === null,
    )
  );
}

/** What the answer cell says beside an answer that is not a draft (2026-11-21). */
export function dailyAnswerNote(answer: DailyAnswer) {
  switch (answer.state) {
    case 'unconfirmed':
      return '전송 확인 필요';
    case 'queued':
      return '휴대폰 대기';
    case 'failed':
      return answer.errorCode === null ? '등록 실패' : `등록 실패 (Meta 코드 ${answer.errorCode})`;
    case 'unknown':
      return '휴대폰에서 [재등록] 또는 [등록 완료]';
    default:
      return null;
  }
}

/** The answers of a published post's card: the ones on the phone, and the ones to check there. */
export function dailyAnswerBadges(replies: DailyReplySummary) {
  const waiting = replies.answers.queued + replies.answers.failed;
  return [
    ...(waiting > 0 ? [`답글 대기 ${waiting}`] : []),
    ...(replies.answers.unknown > 0 ? ['휴대폰에서 확인 필요'] : []),
  ];
}

/** The drafts [모바일로 보내기] sends, in the order they were written. */
export const dailyAnswerDrafts = (thread: DailyReplyThread) =>
  thread.answers.filter((answer) => answer.state === 'draft');

export const dailyInitial = (name: string) => [...name.trim()][0] ?? '?';

/**
 * The fixed items of the persona description form. 직업 says what kind of person this is, so the
 * posts come out of that life (2026-11-18). 이모지 is how many emoji the user wants in one post;
 * the writer is asked for it in every language and falls back to the language's own habit when
 * it is left blank.
 */
export const DAILY_DESCRIPTION_LABELS = [
  '나이',
  '직업',
  '가족',
  '거주지',
  '관심사',
  '말투',
  '이모지',
];

/** Example personas shown in the empty form; `values` follows `DAILY_DESCRIPTION_LABELS`. */
export const dailyPersonaExamples = [
  {
    name: '연년생 아들맘',
    values: [
      '30세',
      '전업주부',
      '남편, 5살·4살 아들',
      '수원',
      '육아, 살림, 아이 교육',
      '편한 반말, 솔직한 편',
      '1~2개',
    ],
  },
  {
    name: '자취 3년차 직장인',
    values: [
      '27세',
      '마케팅 회사 대리',
      '혼자 삼, 고양이 한 마리',
      '서울 마포구',
      '퇴근 후 요리, 재테크',
      '담담한 존댓말',
      '0~1개',
    ],
  },
  {
    name: '은퇴한 캠핑 아빠',
    values: [
      '58세',
      '퇴직 후 쉬는 중',
      '아내, 독립한 딸 하나',
      '강원 원주',
      '캠핑, 텃밭, 등산',
      '느긋한 존댓말',
      '0개',
    ],
  },
  {
    name: '새내기 대학생',
    values: [
      '20세',
      '대학교 1학년',
      '부모님, 고3 남동생',
      '부산, 기숙사 생활',
      '동아리, 알바, 맛집',
      '발랄한 반말',
      '2~3개',
    ],
  },
];

export type DailyPersonaExample = (typeof dailyPersonaExamples)[number];

/** The form values read back from a saved description; lines of no item are left out. */
export function dailyDescriptionValues(description: string) {
  const lines = description.split('\n');
  return DAILY_DESCRIPTION_LABELS.map((label) => {
    const line = lines.find((item) => item.startsWith(`${label}:`));
    return line ? line.slice(label.length + 1).trim() : '';
  });
}

/** The saved description: one `item: value` line for each item that was filled in. */
export function dailyDescriptionText(values: string[]) {
  return DAILY_DESCRIPTION_LABELS.flatMap((label, index) => {
    const value = values[index]?.trim();
    return value ? [`${label}: ${value}`] : [];
  }).join('\n');
}
