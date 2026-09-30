/**
 * Stable per-identity colours.
 *
 * We store a CSS variable reference rather than a concrete colour so each
 * theme can retune the 12 hues for its own background while every contact
 * keeps the same *slot* everywhere and forever.
 */

export const AVATAR_HUE_COUNT = 12;

/** FNV-1a 32-bit: tiny, fast, well distributed for short ids. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 1-based hue slot for an id. */
export function avatarHueIndex(id: string): number {
  return (hashString(id) % AVATAR_HUE_COUNT) + 1;
}

/** CSS colour value (`var(--hearth-avatar-N)`) for an id. */
export function colorForId(id: string): string {
  return `var(--hearth-avatar-${avatarHueIndex(id)})`;
}

/** Up to two initials for avatar fallbacks, grapheme-aware for emoji names. */
export function initialsFor(name: string): string {
  const words = name
    .trim()
    .split(/\s+/u)
    .filter((w) => w.length > 0);
  // First grapheme, so flags and ZWJ emoji stay intact.
  const first = (w: string | undefined): string => {
    if (!w) return '';
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      w,
    )) {
      return segment;
    }
    return '';
  };
  if (words.length === 0) return '?';
  if (words.length === 1) return first(words[0]).toUpperCase();
  return (first(words[0]) + first(words.at(-1))).toUpperCase();
}
