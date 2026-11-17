import type { DailyPersona, DailyPost, DailyView, DailyWaitingNote } from '../shared/daily';
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
  return !!persona && persona.language !== 'ko' && post.translation === null;
}

export const dailyInitial = (name: string) => [...name.trim()][0] ?? '?';

/** The fixed items of the persona description form. */
export const DAILY_DESCRIPTION_LABELS = ['나이', '가족', '거주지', '관심사', '말투'];

/** Example personas shown in the empty form; `values` follows `DAILY_DESCRIPTION_LABELS`. */
export const dailyPersonaExamples = [
  {
    name: '연년생 아들맘',
    values: ['30세', '남편, 5살·4살 아들', '수원', '육아, 살림, 아이 교육', '편한 반말, 솔직한 편'],
  },
  {
    name: '자취 3년차 직장인',
    values: [
      '27세',
      '혼자 삼, 고양이 한 마리',
      '서울 마포구',
      '퇴근 후 요리, 재테크',
      '담담한 존댓말',
    ],
  },
  {
    name: '은퇴한 캠핑 아빠',
    values: ['58세', '아내, 독립한 딸 하나', '강원 원주', '캠핑, 텃밭, 등산', '느긋한 존댓말'],
  },
  {
    name: '새내기 대학생',
    values: [
      '20세',
      '부모님, 고3 남동생',
      '부산, 기숙사 생활',
      '동아리, 알바, 맛집',
      '발랄한 반말',
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
