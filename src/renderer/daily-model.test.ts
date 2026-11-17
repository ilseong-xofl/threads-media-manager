import { describe, expect, it } from 'vitest';
import type { DailyPersona, DailyPost } from '../shared/daily';
import type { ManagedThreadsAccountRow } from '../shared/managed-threads';
import {
  dailyAccountChoices,
  dailyAccountLocked,
  dailyColumnCount,
  dailyDay,
  dailyNoteLabel,
  dailyRangeLabel,
  dailySendBlock,
  dailyTime,
  dailyWindow,
  dailyWindowFor,
  groupDailyPosts,
} from './daily-model';

const at = (day: number, hour = 9, minute = 0) =>
  new Date(2026, 10, day, hour, minute).toISOString();
function post(id: string, change: Partial<DailyPost> = {}): DailyPost {
  return {
    id,
    personaId: 'p1',
    text: id,
    createdAt: at(1),
    state: 'draft',
    note: null,
    started: false,
    sentAt: null,
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
