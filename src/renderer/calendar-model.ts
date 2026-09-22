function parseDate(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

function monthStart(month: string): Date {
  const date = parseDate(`${month}-01`);
  if (!date) throw new RangeError('Invalid calendar month');
  return date;
}

export function calendarDays(
  month: string,
): Array<{ date: string; day: number; inMonth: boolean }> {
  const first = monthStart(month);
  const cursor = new Date(first);
  cursor.setUTCDate(1 - first.getUTCDay());
  return Array.from({ length: 42 }, () => {
    const date = cursor.toISOString().slice(0, 10);
    const result = { date, day: cursor.getUTCDate(), inMonth: date.slice(0, 7) === month };
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    return result;
  });
}

export function shiftMonth(month: string, delta: number): string {
  if (!Number.isInteger(delta)) throw new RangeError('Month shift must be an integer');
  const date = monthStart(month);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function shiftDay(value: string, delta: number): string {
  const date = parseDate(value);
  if (!date || !Number.isInteger(delta)) throw new RangeError('Invalid calendar day shift');
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function isDateAllowed(date: string, min?: string, max?: string): boolean {
  return (
    !!parseDate(date) &&
    (!min || (!!parseDate(min) && date >= min)) &&
    (!max || (!!parseDate(max) && date <= max))
  );
}
