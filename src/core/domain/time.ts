/**
 * Timestamp formatting.
 *
 * Clock times are formatted by hand (not Intl) so 12/24h output is identical
 * across ICU versions — some insert U+202F before "PM", which breaks layouts
 * and tests alike. Dates (day, month, weekday names and their order) come from Intl
 * and follow the system locale.
 * All functions work in the runtime's local time zone.
 */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface TimeFormatOptions {
  clock24h: boolean;
}

export function formatClock(ts: number, { clock24h }: TimeFormatOptions): string {
  const d = new Date(ts);
  const h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  if (clock24h) return `${String(h).padStart(2, '0')}:${m}`;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${m} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Local calendar day key `YYYY-MM-DD`, used for day grouping. */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function isSameDay(a: number, b: number): boolean {
  return dayKey(a) === dayKey(b);
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Whole calendar days between two instants (DST-safe). */
export function calendarDaysBetween(from: number, to: number): number {
  return Math.round((startOfDay(to) - startOfDay(from)) / DAY);
}

/**
 * Date parts follow `locale`; left undefined it is the runtime's own locale,
 * so dates read the way the user's system writes them. Tests pin one.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function datePart(ts: number, locale: string | undefined, options: Intl.DateTimeFormatOptions) {
  // Building a formatter costs far more than using one, and the message list
  // formats a date per row, so each locale + options pair is made once.
  const key = `${locale ?? ''}|${JSON.stringify(options)}`;
  let fmt = formatters.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    formatters.set(key, fmt);
  }
  return fmt.format(new Date(ts));
}

/** "Tuesday, 29 September 2026" (en-GB) — day divider label. */
export function formatDayDivider(ts: number, locale?: string): string {
  return datePart(ts, locale, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "Tuesday, 29 September 2026 at 14:02" — full tooltip form. */
export function formatFullTimestamp(ts: number, opts: TimeFormatOptions, locale?: string): string {
  return `${formatDayDivider(ts, locale)} at ${formatClock(ts, opts)}`;
}

/** "Today at 14:02", "Yesterday at 2:02 PM", or "29/09/2026 14:02" (en-GB). */
export function formatMessageTimestamp(
  ts: number,
  now: number,
  opts: TimeFormatOptions,
  locale?: string,
): string {
  const days = calendarDaysBetween(ts, now);
  const clock = formatClock(ts, opts);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  const date = datePart(ts, locale, { day: 'numeric', month: 'numeric', year: 'numeric' });
  return `${date} ${clock}`;
}

/** Compact relative time: "just now", "3m ago", "2h ago", "4d ago", then a date. */
export function formatRelative(ts: number, now: number, locale?: string): string {
  const delta = Math.max(0, now - ts);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return datePart(ts, locale, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Human label for a disappearing-message timer, e.g. "1 week", "30 seconds". */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return 'Off';
  const units: [number, string][] = [
    [7 * 86_400, 'week'],
    [86_400, 'day'],
    [3_600, 'hour'],
    [60, 'minute'],
    [1, 'second'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size && seconds % size === 0) {
      const n = seconds / size;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${seconds} seconds`;
}
