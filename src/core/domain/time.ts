/**
 * Timestamp formatting.
 *
 * Clock times are formatted by hand (not Intl) so 12/24h output is identical
 * across ICU versions — some insert U+202F before "PM", which breaks layouts
 * and tests alike. Month/weekday names still come from Intl for localisation.
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

function namePart(ts: number, locale: string, part: 'weekday' | 'month'): string {
  const fmt = new Intl.DateTimeFormat(locale, { [part]: 'long' });
  return fmt.formatToParts(new Date(ts)).find((p) => p.type === part)?.value ?? '';
}

/** "Tuesday, 29 September 2026" — day divider label. */
export function formatDayDivider(ts: number, locale = 'en-GB'): string {
  const d = new Date(ts);
  return `${namePart(ts, locale, 'weekday')}, ${d.getDate()} ${namePart(ts, locale, 'month')} ${d.getFullYear()}`;
}

/** "Tuesday, 29 September 2026 at 14:02" — full tooltip form. */
export function formatFullTimestamp(ts: number, opts: TimeFormatOptions, locale = 'en-GB'): string {
  return `${formatDayDivider(ts, locale)} at ${formatClock(ts, opts)}`;
}

/** "Today at 14:02", "Yesterday at 2:02 PM", or "29/09/2026 14:02". */
export function formatMessageTimestamp(ts: number, now: number, opts: TimeFormatOptions): string {
  const days = calendarDaysBetween(ts, now);
  const clock = formatClock(ts, opts);
  if (days === 0) return `Today at ${clock}`;
  if (days === 1) return `Yesterday at ${clock}`;
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()} ${clock}`;
}

/** Compact relative time: "just now", "3m ago", "2h ago", "4d ago", then a date. */
export function formatRelative(ts: number, now: number): string {
  const delta = Math.max(0, now - ts);
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  const d = new Date(ts);
  return `${d.getDate()} ${namePart(ts, 'en-GB', 'month').slice(0, 3)} ${d.getFullYear()}`;
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
