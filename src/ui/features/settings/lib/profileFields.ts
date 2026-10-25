import { PROFILE_LIMITS, normalizeProfileText, type FieldLimit } from '@/core/domain';
import { graphemes, truncateToLimits, utf8Length } from '@/core/lib';

export type ProfileField = keyof typeof PROFILE_LIMITS;

/** `text` cut to what Signal accepts for the field (a paste that is too long loses its end). */
export function fitField(text: string, field: ProfileField): string {
  const limit: FieldLimit = PROFILE_LIMITS[field];
  return truncateToLimits(text, limit.bytes, limit.graphemes);
}

/**
 * How much room is left in the field, as Signal Desktop's counter shows it:
 * the tighter of the character and byte limits, and only once at least half
 * of that is used. `warn` is the last quarter.
 */
export function fieldCounter(
  text: string,
  field: ProfileField,
): { remaining: number; visible: boolean; warn: boolean } {
  const limit: FieldLimit = PROFILE_LIMITS[field];
  if (text.length === 0) return { remaining: limit.graphemes, visible: false, warn: false };
  const byGraphemes = limit.graphemes - graphemes(text).length;
  const byBytes = limit.bytes - utf8Length(text);
  const [remaining, max] =
    byBytes > byGraphemes ? [byGraphemes, limit.graphemes] : [byBytes, limit.bytes];
  return { remaining, visible: remaining <= max * 0.5, warn: remaining <= max * 0.25 };
}

/** The editor's text fields as they're saved. */
export interface ProfileDraft {
  givenName: string;
  familyName: string;
  about: string;
  aboutEmoji: string;
}

export function normalizeDraft(draft: ProfileDraft): ProfileDraft {
  const about = normalizeProfileText(draft.about);
  return {
    givenName: normalizeProfileText(draft.givenName),
    familyName: normalizeProfileText(draft.familyName),
    about,
    // As in Desktop, an emoji only goes with some about text.
    aboutEmoji: about ? draft.aboutEmoji : '',
  };
}

export function sameDraft(a: ProfileDraft, b: ProfileDraft): boolean {
  const x = normalizeDraft(a);
  const y = normalizeDraft(b);
  return (
    x.givenName === y.givenName &&
    x.familyName === y.familyName &&
    x.about === y.about &&
    x.aboutEmoji === y.aboutEmoji
  );
}
