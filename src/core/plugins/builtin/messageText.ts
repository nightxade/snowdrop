/** U+FFFC marks a mention in a body; each counts as one word / one character. */
const MENTION = String.fromCharCode(0xfffc);

/** Words in a message body, counting runs of letters/digits (works for most scripts; CJK counts per run). */
export function wordCount(text: string): number {
  return text.match(/[\p{L}\p{N}￼][\p{L}\p{N}\p{M}'’_-]*/gu)?.length ?? 0;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as people count them: grapheme clusters, so a family emoji is one. */
export function charCount(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text.replaceAll(MENTION, '@'))) n++;
  return n;
}
