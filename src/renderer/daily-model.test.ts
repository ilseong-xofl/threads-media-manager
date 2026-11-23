import { describe, expect, it } from 'vitest';
import type {
  DailyAnswer,
  DailyPersona,
  DailyPost,
  DailyReply,
  DailyReplyThread,
} from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import {
  dailyAnswerBadges,
  dailyAnswerNote,
  dailyAccountChoices,
  dailyAccountLocked,
  dailyDescriptionText,
  dailyDescriptionValues,
  dailyColumnCount,
  dailyDay,
  dailyNoteLabel,
  dailyRangeLabel,
  dailySendBlock,
  dailyTime,
  dailyWindow,
  dailyWindowFor,
  dailyReplyMedia,
  dailyReplyRows,
  dailyRepliesTranslatable,
  groupDailyPosts,
} from './daily-model';

const at = (day: number, hour = 9, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
function post(id: string, change: Partial<DailyPost> = {}): DailyPost {
  return {
    id,
    personaId: 'p1',
    text: id,
    translation: null,
    topic: null,
    createdAt: at(1),
    state: 'draft',
    note: null,
    started: false,
    sentAt: null,
    replies: null,
    ...change,
  };
}
function persona(id: string, accountId: string): DailyPersona {
  return { id, name: id, accountId, language: 'ko', description: '', createdAt: at(1) };
}
function row(id: string, change: Partial<ManagedThreadsAccountRow> = {}): ManagedThreadsAccountRow {
  return {
    localId: `local-${id}`,
    label: id,
    appName: `${id} 앱`,
    registrationId: `registration-${id}`,
    appId: null,
    account: {
      id,
      ownerId: 'owner',
      label: id,
      registrationId: `registration-${id}`,
      appName: `${id} 앱`,
      appId: null,
      threadsUserId: null,
      validationStatus: 'reported_valid',
      tokenRevision: 1,
      expiresAt: null,
      createdAt: at(1),
    },
    localRevision: 1,
    localState: 'synced',
    pendingAction: null,
    pendingReason: null,
    pendingDeletion: false,
    lastCheck: null,
    ...change,
  };
}

describe('daily post groups', () => {
  it('keeps one persona and orders drafts, waiting and published posts newest first', () => {
    const groups = groupDailyPosts(
      [
        post('old-draft', { createdAt: at(1) }),
        post('new-draft', { createdAt: at(3) }),
        post('other', { personaId: 'p2' }),
        post('unconfirmed', { state: 'waiting', note: 'unconfirmed', createdAt: at(5) }),
        post('sent', { state: 'waiting', sentAt: at(4) }),
        post('published-old', { state: 'published', sentAt: at(2) }),
        post('published-new', { state: 'published', sentAt: at(6), createdAt: at(1) }),
      ],
      'p1',
    );
    expect(groups.drafts.map((p) => p.id)).toEqual(['new-draft', 'old-draft']);
    expect(groups.waiting.map((p) => p.id)).toEqual(['unconfirmed', 'sent']);
    expect(groups.published.map((p) => p.id)).toEqual(['published-new', 'published-old']);
  });
});

describe('daily account choices', () => {
  const rows = [
    row('a'),
    row('b'),
    row('gone', { pendingDeletion: true }),
    row('local', { account: null }),
  ];
  it('offers usable accounts that no other persona uses, including the edited persona’s own', () => {
    const personas = [persona('p1', 'a'), persona('p2', 'b')];
    expect(dailyAccountChoices(rows, personas).map((r) => r.account!.id)).toEqual([]);
    expect(dailyAccountChoices(rows, personas, 'p1').map((r) => r.account!.id)).toEqual(['a']);
    expect(dailyAccountChoices(rows, [persona('p2', 'b')]).map((r) => r.account!.id)).toEqual([
      'a',
    ]);
  });
  it('locks the account once the persona has posts unless the account was removed', () => {
    const p1 = persona('p1', 'a');
    expect(dailyAccountLocked(p1, [], rows)).toBe(false);
    expect(dailyAccountLocked(p1, [post('x', { personaId: 'p2' })], rows)).toBe(false);
    expect(dailyAccountLocked(p1, [post('x')], rows)).toBe(true);
    expect(dailyAccountLocked(persona('p1', 'deleted'), [post('x')], rows)).toBe(false);
  });
  it('explains why a persona cannot send', () => {
    expect(dailySendBlock(persona('p1', 'a'), rows, false)).toContain('확인하고');
    expect(dailySendBlock(persona('p1', 'deleted'), rows, true)).toContain('계정 관리에 없습니다');
    expect(
      dailySendBlock(persona('p1', 'a'), [row('a', { pendingAction: 'replace' })], true),
    ).toContain('갱신 재시도');
    expect(dailySendBlock(persona('p1', 'a'), rows, true)).toBeNull();
  });
});

describe('daily board window', () => {
  it('fits columns of at least the minimum width and never fewer than one', () => {
    expect(dailyColumnCount(1247)).toBe(3);
    expect(dailyColumnCount(1248)).toBe(4);
    expect(dailyColumnCount(200)).toBe(1);
    expect(dailyColumnCount(0)).toBe(1);
  });
  it('fills the last page from the end and moves only when a persona is hidden', () => {
    expect(dailyWindow(0, 7, 4)).toEqual({ start: 0, end: 4 });
    expect(dailyWindow(4, 7, 4)).toEqual({ start: 3, end: 7 });
    expect(dailyWindow(2, 2, 4)).toEqual({ start: 0, end: 2 });
    expect(dailyWindowFor(2, 0, 7, 4)).toBe(0);
    expect(dailyWindowFor(5, 0, 7, 4)).toBe(3);
    expect(dailyWindowFor(1, 3, 7, 4)).toBe(1);
    expect(dailyRangeLabel(0, 4, 7)).toBe('1–4 / 7');
    expect(dailyRangeLabel(2, 3, 7)).toBe('3 / 7');
  });
});

describe('daily labels', () => {
  it('names each waiting note and shows none for an untouched send', () => {
    expect(dailyNoteLabel('unconfirmed')).toBe('전송 확인 필요');
    expect(dailyNoteLabel('check_phone')).toBe('휴대폰에서 확인 필요');
    expect(dailyNoteLabel('failed')).toBe('등록 실패');
    expect(dailyNoteLabel('expired')).toBe('기한 지남');
    expect(dailyNoteLabel(null)).toBeNull();
  });
  it('formats times relative to today and days for published posts', () => {
    const now = new Date(2026, 10, 17, 18, 0);
    expect(dailyTime(at(17, 14, 5), now)).toBe('오늘 14:05');
    expect(dailyTime(at(15, 9, 30), now)).toBe('11. 15. 09:30');
    expect(dailyDay(at(15))).toBe('11. 15.');
  });
});

describe('daily persona description', () => {
  it('saves only the items that were filled in', () => {
    expect(dailyDescriptionText(['', '', '', '', '', '', ''])).toBe('');
    expect(dailyDescriptionText([' 30세 ', '배달 기사', '', '  ', '육아', '', ' 0개 '])).toBe(
      '나이: 30세\n직업: 배달 기사\n관심사: 육아\n이모지: 0개',
    );
  });

  it('reads the items back and leaves other lines out', () => {
    expect(dailyDescriptionValues('나이: 30세\n관심사: 육아, 살림')).toEqual([
      '30세',
      '',
      '',
      '',
      '육아, 살림',
      '',
      '',
    ]);
    expect(dailyDescriptionValues('30세 여성. 전업주부')).toEqual(['', '', '', '', '', '', '']);
    const values = ['30세', '전업주부', '남편', '수원', '육아', '반말', '1~2개'];
    expect(dailyDescriptionValues(dailyDescriptionText(values))).toEqual(values);
  });
});

describe('daily replies window', () => {
  const reply = (
    threadsId: string,
    parentThreadsId: string,
    hour: number,
    change: Partial<DailyReply> = {},
  ): DailyReply => ({
    threadsId,
    parentThreadsId,
    username: `user${threadsId}`,
    text: `text ${threadsId}`,
    translation: null,
    mediaType: 'TEXT_POST',
    hasLink: true,
    ownedByMe: false,
    postedAt: at(21, hour),
    ...change,
  });
  const thread = (replies: DailyReply[]): DailyReplyThread => ({
    postId: 'post',
    fetchedAt: at(21, 20),
    rootThreadsId: '900',
    replies,
    answers: [],
  });
  it('lists replies to the post newest first, each followed by the replies under it, oldest first', () => {
    const rows = dailyReplyRows(
      thread([
        // Newest first, as the server sends them.
        reply('6', '5', 15),
        reply('5', '1', 14),
        reply('4', '900', 13),
        reply('3', '1', 12),
        reply('2', '900', 11),
        reply('1', '900', 10),
      ]),
    );
    expect(rows.map((row) => [row.reply.threadsId, row.nested, row.orphan, row.to])).toEqual([
      ['4', false, false, null],
      ['2', false, false, null],
      ['1', false, false, null],
      ['3', true, false, null],
      ['5', true, false, null],
      // Under a reply that is itself nested, it says whose reply it answers.
      ['6', true, false, 'user5'],
    ]);
  });
  it('keeps a reply whose parent was not fetched at the top level, marked as a reply to a reply', () => {
    const rows = dailyReplyRows(
      thread([reply('8', '7', 16), reply('7', '404', 15), reply('2', '900', 11)]),
    );
    expect(rows.map((row) => [row.reply.threadsId, row.nested, row.orphan])).toEqual([
      ['7', false, true],
      ['8', true, false],
      ['2', false, false],
    ]);
    // Replies that point at each other still end, each at the top.
    expect(dailyReplyRows(thread([reply('1', '2', 10), reply('2', '1', 11)]))).toHaveLength(2);
  });
  it('draws a line under the replies that came since the last look, and tags a new one under an older reply', () => {
    const fresh = { fresh: true } as const;
    const rows = dailyReplyRows(
      thread([
        reply('7', '5', 16, fresh),
        reply('6', '3', 15, fresh),
        reply('5', '900', 14, fresh),
        reply('4', '900', 13, fresh),
        reply('3', '900', 12),
        reply('2', '900', 11),
      ]),
    );
    expect(rows.map((row) => [row.reply.threadsId, row.divider, row.fresh])).toEqual([
      ['5', false, false],
      // Under a new reply everything is new: the line says so, no tag.
      ['7', false, false],
      ['4', false, false],
      // The first reply seen before: the line goes above it.
      ['3', true, false],
      ['6', false, true],
      ['2', false, false],
    ]);
    // Our own new reply under an older one needs no tag.
    expect(
      dailyReplyRows(
        thread([reply('6', '3', 15, { fresh: true, ownedByMe: true }), reply('3', '900', 12)]),
      ).map((row) => [row.divider, row.fresh]),
    ).toEqual([
      [false, false],
      [false, false],
    ]);
    // Nothing older (a first look) or nothing new: no line.
    const lines = (replies: DailyReply[]) =>
      dailyReplyRows(thread(replies)).filter((row) => row.divider).length;
    expect(lines([reply('2', '900', 11, fresh), reply('1', '900', 10, fresh)])).toBe(0);
    expect(lines([reply('2', '900', 11), reply('1', '900', 10)])).toBe(0);
  });
  it('names images and videos, and offers Korean only for other people’s replies in another language', () => {
    expect(['IMAGE', 'CAROUSEL_ALBUM', 'VIDEO', 'TEXT_POST', 'AUDIO'].map(dailyReplyMedia)).toEqual(
      ['[이미지]', '[이미지]', '[영상]', null, null],
    );
    const own = reply('1', '900', 10, { ownedByMe: true });
    const image = reply('2', '900', 11, { text: ' ', mediaType: 'IMAGE' });
    const done = reply('3', '900', 12, { translation: '뜻' });
    expect(dailyRepliesTranslatable(thread([own, image, done]), 'en')).toBe(false);
    expect(dailyRepliesTranslatable(thread([own, reply('4', '900', 13)]), 'en')).toBe(true);
    expect(dailyRepliesTranslatable(thread([reply('4', '900', 13)]), 'ko')).toBe(false);
  });
});

describe('daily answers', () => {
  const answer = (state: DailyAnswer['state'], errorCode: number | null = null): DailyAnswer => ({
    id: 'a',
    replyThreadsId: '1',
    text: 'Hi',
    translation: null,
    state,
    errorCode,
    postedBefore: false,
  });
  it('says where each answer stands, with the Meta code of a refusal', () => {
    expect(
      (['draft', 'unconfirmed', 'queued', 'unknown'] as const).map((state) =>
        dailyAnswerNote(answer(state)),
      ),
    ).toEqual([null, '전송 확인 필요', '휴대폰 대기', '휴대폰에서 [재등록] 또는 [등록 완료]']);
    expect(dailyAnswerNote(answer('failed'))).toBe('등록 실패');
    expect(dailyAnswerNote(answer('failed', 190))).toBe('등록 실패 (Meta 코드 190)');
  });
  it('counts the answers on the phone on the card, and asks to check the ones it cannot tell', () => {
    const summary = (queued: number, failed: number, unknown: number) => ({
      fetchedAt: '2026-11-21T05:00:00.000Z',
      count: 2,
      fresh: 0,
      answers: { queued, failed, unknown },
    });
    expect(dailyAnswerBadges(summary(0, 0, 0))).toEqual([]);
    expect(dailyAnswerBadges(summary(2, 1, 0))).toEqual(['답글 대기 3']);
    expect(dailyAnswerBadges(summary(0, 0, 1))).toEqual(['휴대폰에서 확인 필요']);
  });
});
