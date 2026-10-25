/**
 * What Signal accepts in your own profile, as Signal Desktop enforces it:
 * a name or about text must fit both a character count and a UTF-8 byte
 * count, whichever runs out first.
 */
export interface FieldLimit {
  graphemes: number;
  bytes: number;
}

export const PROFILE_LIMITS = {
  name: { graphemes: 26, bytes: 128 },
  about: { graphemes: 140, bytes: 512 },
} as const satisfies Record<string, FieldLimit>;

/** Longest square side, in pixels, of a profile photo (Desktop crops and shrinks to this). */
export const PROFILE_AVATAR_MAX_SIDE = 512;

/** A name as saved: trimmed, and with no line breaks. */
export function normalizeProfileText(text: string): string {
  return text.replace(/[\r\n]+/gu, ' ').trim();
}
