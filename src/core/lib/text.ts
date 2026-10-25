/**
 * Bidi control characters (LRE/RLE/LRO/RLO/PDF, LRI/RLI/FSI/PDI, LRM/RLM, ALM) let a
 * string reorder or visually hide text around it. Attacker-controlled strings
 * (contact names, group titles, filenames, quoted authors) can carry them, so
 * anything built from such strings should run through this first — notably
 * before being used outside a CSS-isolated element (e.g. an `<a download>`
 * name, or interpolated into a plain-text sentence).
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/gu;

export function stripBidiControls(s: string): string {
  return s.replace(BIDI_CONTROLS, '');
}

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** User-perceived characters in `text` (an emoji with modifiers counts once). */
export function graphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

const encoder = new TextEncoder();

/** Length of `text` once encoded as UTF-8, which is what Signal's byte limits count. */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The longest start of `text` that fits both limits, cut on a whole
 * character (never through an emoji or a surrogate pair).
 */
export function truncateToLimits(text: string, maxBytes: number, maxGraphemes: number): string {
  let out = '';
  let bytes = 0;
  let count = 0;
  for (const g of graphemes(text)) {
    const next = bytes + utf8Length(g);
    if (next > maxBytes || count + 1 > maxGraphemes) break;
    out += g;
    bytes = next;
    count += 1;
  }
  return out;
}
