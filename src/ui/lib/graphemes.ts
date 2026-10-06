/**
 * Splits text into grapheme clusters, so a ZWJ emoji family or a flag counts
 * as one "character" rather than several UTF-16 code points. Guarded for an
 * engine without `Intl.Segmenter` (hoisted from
 * src/ui/plugins/vim/engine/text.ts, which needs the exact same guard for
 * its own grapheme-aware cursor math): falls back to `Array.from(text)`,
 * which still splits most multi-code-point emoji into more than one
 * "character" — not perfect, but it never throws.
 */
const segmenter: Intl.Segmenter | null =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

/** Grapheme clusters of `text`, in order. */
export function splitGraphemes(text: string): string[] {
  if (segmenter) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}
