/**
 * What the user typed to start a new chat: a phone number or a username.
 *
 * Mirrors Signal Desktop's "Find by phone number" / "Find by username" rules.
 * Numbers are normalised to E.164 (a leading `00` counts as `+`, and, like
 * Desktop's default region, a national number is read as NANP when the user's
 * own number is). Usernames are `name.123`, with or without a leading `@`.
 */

/** A recipient looked up with the server (contact discovery or the username directory). */
export type RecipientQuery =
  { kind: 'phone'; e164: string } | { kind: 'username'; username: string };

export interface RecipientInput {
  /** The number as E.164, when the text is one. */
  phone: string | null;
  /** The username without `@`, when the text is one. */
  username: string | null;
  /** Looks like a phone number but has no country code to read it with. */
  needsCountryCode: boolean;
}

const PHONE_CHARS = /^\+?[\d\s().-]+$/u;
const USERNAME = /^[A-Za-z_][A-Za-z0-9_]{2,31}\.(\d{2,})$/u;

/** E.164 allows 15 digits; 7 is the shortest real number. */
const MIN_DIGITS = 7;
const MAX_DIGITS = 15;

export function parsePhoneInput(input: string, selfNumber?: string): string | null {
  const text = input.trim();
  if (!PHONE_CHARS.test(text)) return null;
  let digits = text.replace(/\D/gu, '');
  let international = text.startsWith('+');
  if (!international && digits.startsWith('00')) {
    digits = digits.slice(2);
    international = true;
  }
  if (!international) {
    // Desktop reads a national number in the user's own region; the only
    // region we can tell without per-country metadata is NANP (+1).
    if (!selfNumber?.startsWith('+1')) return null;
    if (digits.length === 10 && /^[2-9]/u.test(digits)) digits = `1${digits}`;
    else if (!(digits.length === 11 && digits.startsWith('1'))) return null;
  }
  if (!/^[1-9]/u.test(digits) || digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) {
    return null;
  }
  return `+${digits}`;
}

export function parseUsernameInput(input: string): string | null {
  let text = input.trim();
  if (text.startsWith('@')) text = text.slice(1);
  const discriminator = USERNAME.exec(text)?.[1];
  if (discriminator === undefined) return null;
  // Signal reserves 00 and requires a leading zero to be the whole two digits.
  if (discriminator.startsWith('00')) return null;
  if (discriminator.startsWith('0') && discriminator.length !== 2) return null;
  return text;
}

export function classifyRecipientInput(input: string, selfNumber?: string): RecipientInput {
  const phone = parsePhoneInput(input, selfNumber);
  const username = phone ? null : parseUsernameInput(input);
  const text = input.trim();
  const needsCountryCode =
    phone === null &&
    username === null &&
    PHONE_CHARS.test(text) &&
    !text.startsWith('+') &&
    text.replace(/\D/gu, '').length >= 5;
  return { phone, username, needsCountryCode };
}
