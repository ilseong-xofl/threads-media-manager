import { describe, expect, it } from 'vitest';
import { defaultDateRange, matchesDateRange } from './date-range';

describe('default KST date range', () => {
  it.each([
    ['2026-09-22T00:00:00Z', '2026-08-22', '2026-09-22'],
    ['2026-03-31T00:00:00Z', '2026-02-28', '2026-03-31'],
    ['2024-03-31T00:00:00Z', '2024-02-29', '2024-03-31'],
    ['2026-05-31T00:00:00Z', '2026-04-30', '2026-05-31'],
    ['2026-01-31T00:00:00Z', '2025-12-31', '2026-01-31'],
    ['2026-01-31T14:59:59.999Z', '2025-12-31', '2026-01-31'],
    ['2026-01-31T15:00:00Z', '2026-01-01', '2026-02-01'],
    ['2025-12-31T15:00:00Z', '2025-12-01', '2026-01-01'],
  ])('uses a calendar month before %s and clamps its month end', (instant, from, to) => {
    const now = new Date(instant);
    expect(defaultDateRange(now)).toEqual({ from, to });
    expect(now.toISOString()).toBe(new Date(instant).toISOString());
  });
});

describe('inclusive KST date filtering', () => {
  const range = { from: '2026-08-22', to: '2026-09-22' };

  it.each([
    ['2026-08-21T14:59:59.999Z', false],
    ['2026-08-21T15:00:00Z', true],
    ['2026-09-22T14:59:59.999Z', true],
    ['2026-09-22T15:00:00Z', false],
    ['2026-09-22T23:59:59.999+09:00', true],
  ])('compares %s by KST day, including the entire ending day', (value, matches) => {
    expect(matchesDateRange(value, range)).toBe(matches);
  });

  it('accepts the same KST day across UTC and explicit negative offsets', () => {
    const oneDay = { from: '2026-09-22', to: '2026-09-22' };
    expect(matchesDateRange('2026-09-21T15:00:00Z', oneDay)).toBe(true);
    expect(matchesDateRange('2026-09-21T08:00:00-07:00', oneDay)).toBe(true);
    expect(matchesDateRange('2026-09-21T14:59:59.999Z', oneDay)).toBe(false);
  });

  it('treats ISO dates and times without offsets as KST consistently with the source adapter', () => {
    const oneDay = { from: '2026-09-22', to: '2026-09-22' };
    expect(matchesDateRange('2026-09-22', oneDay)).toBe(true);
    expect(matchesDateRange('2026-09-22T23:59:59', oneDay)).toBe(true);
    expect(matchesDateRange('2026-09-21T23:59:59', oneDay)).toBe(false);
  });

  it('supports an open start or end while excluding unknown dates from either bounded range', () => {
    expect(matchesDateRange('2026-01-01', { from: '', to: '2026-09-22' })).toBe(true);
    expect(matchesDateRange('2026-09-23', { from: '', to: '2026-09-22' })).toBe(false);
    expect(matchesDateRange('2027-01-01', { from: '2026-09-22', to: '' })).toBe(true);
    expect(matchesDateRange('2026-09-21', { from: '2026-09-22', to: '' })).toBe(false);
    expect(matchesDateRange(null, { from: '', to: '2026-09-22' })).toBe(false);
    expect(matchesDateRange(null, { from: '2026-09-22', to: '' })).toBe(false);
  });

  it.each([null, '', 'unknown', '2026-02-30T12:00:00Z', '2026-09-22T25:00:00Z'])(
    'excludes invalid or unknown date %s only when a range is set',
    (value) => {
      expect(matchesDateRange(value, range)).toBe(false);
      expect(matchesDateRange(value, { from: '', to: '' })).toBe(true);
    },
  );

  it.each([
    { from: '2026-09-23', to: '2026-09-22' },
    { from: '2026-02-30', to: '' },
    { from: '', to: 'not-a-date' },
  ])('returns no matches for a reversed or invalid range: %j', (invalidRange) => {
    expect(matchesDateRange('2026-09-22T00:00:00Z', invalidRange)).toBe(false);
    expect(matchesDateRange(null, invalidRange)).toBe(false);
  });
});
