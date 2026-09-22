import { describe, expect, it } from 'vitest';
import { calendarDays, isDateAllowed, shiftDay, shiftMonth } from './calendar-model';

describe('calendar model', () => {
  it('builds six Sunday-first weeks with ordered days from adjacent months', () => {
    const days = calendarDays('2026-09');
    expect(days).toHaveLength(42);
    expect(days[0]).toEqual({ date: '2026-08-30', day: 30, inMonth: false });
    expect(days[41]).toEqual({ date: '2026-10-10', day: 10, inMonth: false });
    expect(days.filter((day) => day.inMonth)).toHaveLength(30);
    expect(new Set(days.map((day) => day.date)).size).toBe(42);
    for (let index = 0; index < days.length; index++) {
      const date = new Date(`${days[index].date}T00:00:00Z`);
      expect(date.getUTCDay()).toBe(index % 7);
      expect(days[index].day).toBe(date.getUTCDate());
      if (index > 0)
        expect(date.getTime() - new Date(`${days[index - 1].date}T00:00:00Z`).getTime()).toBe(
          86400000,
        );
    }
  });

  it('starts on the first when the month begins on Sunday and still fills six weeks', () => {
    const days = calendarDays('2026-02');
    expect(days[0]).toEqual({ date: '2026-02-01', day: 1, inMonth: true });
    expect(days[41]).toEqual({ date: '2026-03-14', day: 14, inMonth: false });
    expect(days.filter((day) => day.inMonth)).toHaveLength(28);
  });

  it('includes February 29 only in a leap year', () => {
    expect(calendarDays('2024-02').filter((day) => day.inMonth)).toHaveLength(29);
    expect(calendarDays('2024-02')).toContainEqual({ date: '2024-02-29', day: 29, inMonth: true });
    expect(calendarDays('2025-02').some((day) => day.date === '2025-02-29')).toBe(false);
  });

  it('moves months backward and forward across year boundaries', () => {
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-03', -13)).toBe('2025-02');
    expect(shiftMonth('2026-03', 0)).toBe('2026-03');
  });

  it('moves days across leap days, years, and local daylight-saving boundaries using UTC', () => {
    expect(shiftDay('2024-02-28', 1)).toBe('2024-02-29');
    expect(shiftDay('2024-03-01', -1)).toBe('2024-02-29');
    expect(shiftDay('2025-02-28', 1)).toBe('2025-03-01');
    expect(shiftDay('2025-12-31', 1)).toBe('2026-01-01');
    expect(shiftDay('2026-01-01', -1)).toBe('2025-12-31');
    expect(shiftDay('2026-03-08', 1)).toBe('2026-03-09');
  });

  it('includes both bounds and supports either open end while rejecting reversed ranges', () => {
    expect(isDateAllowed('2026-09-01', '2026-09-01', '2026-09-22')).toBe(true);
    expect(isDateAllowed('2026-09-22', '2026-09-01', '2026-09-22')).toBe(true);
    expect(isDateAllowed('2026-08-31', '2026-09-01', '2026-09-22')).toBe(false);
    expect(isDateAllowed('2026-09-23', '2026-09-01', '2026-09-22')).toBe(false);
    expect(isDateAllowed('2026-08-01', undefined, '2026-09-22')).toBe(true);
    expect(isDateAllowed('2027-01-01', '2026-09-01')).toBe(true);
    expect(isDateAllowed('2026-09-22', '', '')).toBe(true);
    expect(isDateAllowed('2026-09-22', '2026-09-23', '2026-09-21')).toBe(false);
  });

  it('does not normalize invalid dates into selectable days', () => {
    expect(isDateAllowed('2026-02-30')).toBe(false);
    expect(isDateAllowed('')).toBe(false);
    expect(isDateAllowed('2026-09-22', 'invalid')).toBe(false);
    expect(isDateAllowed('2026-09-22', undefined, '2026-02-30')).toBe(false);
    expect(() => calendarDays('2026-13')).toThrow(RangeError);
    expect(() => shiftDay('2026-02-30', 1)).toThrow(RangeError);
    expect(() => shiftMonth('2026-09', 0.5)).toThrow(RangeError);
  });
});
