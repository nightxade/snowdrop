/** `m:ss`, or `h:mm:ss` from an hour up: the clock a player shows. */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The same, as words for a screen reader ("1 minute 5 seconds"). */
export function spokenClock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const parts = [
    ...(h > 0 ? [part(h, 'hour')] : []),
    ...(m > 0 ? [part(m, 'minute')] : []),
    ...(s > 0 || total === 0 ? [part(s, 'second')] : []),
  ];
  return parts.join(' ');
}
