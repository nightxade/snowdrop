/**
 * Readable grouping for E.164 numbers ("+12025550106" → "+1 202 555 0106").
 * Deliberately simple (no per-country metadata): NANP numbers get 3-3-4,
 * others the country code followed by pairs/triples from the right.
 */
export function formatPhone(e164: string): string {
  const m = /^\+(\d{7,15})$/u.exec(e164.replace(/[\s-]/gu, ''));
  if (!m) return e164;
  const digits = m[1] as string;
  if (digits.startsWith('1') && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  // Country codes are 1–3 digits; assume 2 when unknown (most common outside NANP).
  const cc = digits.slice(0, 2);
  const rest = digits.slice(2);
  const groups: string[] = [];
  for (let end = rest.length; end > 0; end -= 3)
    groups.unshift(rest.slice(Math.max(0, end - 3), end));
  return `+${cc} ${groups.join(' ')}`;
}
