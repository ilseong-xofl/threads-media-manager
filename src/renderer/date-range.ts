export type DateRange = { from: string; to: string };

const kstDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function dateKey(date: Date): string {
  const parts = Object.fromEntries(
    kstDate.formatToParts(date).map(({ type, value }) => [type, value]),
  );
  return `${parts.year.padStart(4, '0')}-${parts.month}-${parts.day}`;
}

function validDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function defaultDateRange(now: Date = new Date()): DateRange {
  const to = dateKey(now);
  const currentDay = Number(to.slice(8));
  const previous = new Date(`${to.slice(0, 8)}01T00:00:00Z`);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  const monthEnd = new Date(previous);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1);
  monthEnd.setUTCDate(0);
  previous.setUTCDate(Math.min(currentDay, monthEnd.getUTCDate()));
  return { from: previous.toISOString().slice(0, 10), to };
}

export function matchesDateRange(value: string | null, range: DateRange): boolean {
  if (!range.from && !range.to) return true;
  if (
    (range.from && !validDateKey(range.from)) ||
    (range.to && !validDateKey(range.to)) ||
    (range.from && range.to && range.from > range.to) ||
    !value
  )
    return false;
  const sourceDate = /^(\d{4}-\d{2}-\d{2})(?:T.+)?$/.exec(value);
  if (!sourceDate || !validDateKey(sourceDate[1])) return false;
  // Match the source adapter: an ISO value without an offset is a KST time.
  const normalized =
    value.length === 10
      ? `${value}T00:00:00+09:00`
      : /(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
        ? value
        : `${value}+09:00`;
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) return false;
  const day = dateKey(parsed);
  return (!range.from || day >= range.from) && (!range.to || day <= range.to);
}
