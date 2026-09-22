import { describe, expect, it } from 'vitest';
import { timeInput, trimRange } from './trim-model';

describe('video trim ranges', () => {
  it('selects seconds within the source, including decimal boundaries', () => {
    expect(trimRange('2', '4', 5)).toEqual({ start: 2, end: 4, length: 2 });
    expect(trimRange('0.25', '1.75', 5)).toEqual({ start: 0.25, end: 1.75, length: 1.5 });
    expect(trimRange('0', '5', 5)).toEqual({ start: 0, end: 5, length: 5 });
  });
  it.each([
    ['', '4'],
    [' ', '4'],
    ['2', ''],
    ['NaN', '4'],
    ['2', 'Infinity'],
    ['2s', '4'],
  ])('rejects incomplete or nonfinite input (%s, %s)', (start, end) => {
    expect(trimRange(start, end, 5).error).toBeTruthy();
  });
  it.each([
    ['-1', '4'],
    ['2', '5.01'],
    ['2', '2'],
    ['3', '2'],
    ['6', '7'],
  ])('rejects empty, reversed, or outside ranges (%s, %s)', (start, end) => {
    expect(trimRange(start, end, 5).error).toBeTruthy();
  });
  it.each([0, NaN, Infinity, -1])('waits for a finite positive duration: %s', (duration) => {
    expect(trimRange('0', '1', duration).error).toBeTruthy();
  });
  it('does not round the initial end past the actual duration', () => {
    const duration = 5.1239;
    const end = timeInput(duration);
    expect(end).toBe('5.123');
    expect(trimRange('0', end, duration).error).toBeUndefined();
    expect(timeInput(NaN)).toBe('');
    expect(timeInput(Infinity)).toBe('');
  });
});
