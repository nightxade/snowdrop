import { isRecord } from '@/core/persistence';

/** A named image, shown inline wherever its `:name:` token appears. */
export interface ImageCustomEmoji {
  kind: 'image';
  name: string;
  dataUrl: string;
}

/**
 * A named short run of plain text (e.g. `shrug` → `¯\_(ツ)_/¯`). It is never
 * delivered as an attachment — SendService expands its `:name:` token to
 * `text` before the message is sent, so it reaches everyone as ordinary text.
 */
export interface TextCustomEmoji {
  kind: 'text';
  name: string;
  text: string;
}

export type CustomEmoji = ImageCustomEmoji | TextCustomEmoji;

export function isImageCustomEmoji(emoji: CustomEmoji): emoji is ImageCustomEmoji {
  return emoji.kind === 'image';
}

export function isTextCustomEmoji(emoji: CustomEmoji): emoji is TextCustomEmoji {
  return emoji.kind === 'text';
}

export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
/** Chars, not bytes: a text emoticon is tiny, but still bounded against abuse. */
export const CUSTOM_EMOJI_TEXT_MAX_LENGTH = 200;
const MAX_LIBRARY_CHARS = 1400 * 1024;
export const CUSTOM_EMOJI_NAME = /^[a-z0-9_+-]{1,32}$/u;
const IMAGE_DATA =
  /^data:image\/(png|jpeg|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u;

/**
 * Matches a `:name:` token in message text. Shared by composing (which
 * emoji did the sender use, to deliver alongside the text, or expand inline)
 * and rendering (MessageBody's inline image swap) so both sides agree on
 * exactly the same shape as `CUSTOM_EMOJI_NAME`.
 */
export const CUSTOM_EMOJI_TOKEN = /:([a-z0-9_+-]{1,32}):/gu;

/** The distinct `:name:` tokens in `text`, in first-seen order. */
export function extractCustomEmojiNames(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(CUSTOM_EMOJI_TOKEN)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return [...names];
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Characters as people count them: grapheme clusters, so a flag or ZWJ emoji is one. */
function graphemeLength(text: string): number {
  let n = 0;
  for (const _ of graphemes.segment(text)) n++;
  return n;
}

/**
 * Validates a text emoticon's body: non-empty once trimmed, no control
 * characters (that includes newlines — an emoticon is one line), and no
 * more than `CUSTOM_EMOJI_TEXT_MAX_LENGTH` user-perceived characters.
 * Returns the trimmed text, which is what gets stored and sent.
 */
export function parseEmoticonText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || /\p{Cc}/u.test(text) || graphemeLength(text) > CUSTOM_EMOJI_TEXT_MAX_LENGTH)
    return null;
  return text;
}

export function parseCustomEmoji(value: unknown): CustomEmoji | null {
  if (!isRecord(value) || typeof value.name !== 'string' || !CUSTOM_EMOJI_NAME.test(value.name))
    return null;
  if (value.kind === 'text') {
    const text = parseEmoticonText(value.text);
    return text === null ? null : { kind: 'text', name: value.name, text };
  }
  // No `kind` at all is an older stored entry, from before text emoticons
  // existed — treated as image so nobody's existing collection disappears.
  if (value.kind !== undefined && value.kind !== 'image') return null;
  if (
    typeof value.dataUrl !== 'string' ||
    value.dataUrl.length > (CUSTOM_EMOJI_MAX_BYTES * 4) / 3 + 64
  )
    return null;
  const match = IMAGE_DATA.exec(value.dataUrl);
  if (!match?.[2]) return null;
  return { kind: 'image', name: value.name, dataUrl: value.dataUrl };
}

/** Bound the local library so image data (or a pile of text emoticons) cannot exhaust storage. */
export function parseCustomEmojiLibrary(value: unknown): CustomEmoji[] {
  if (!Array.isArray(value)) return [];
  const result: CustomEmoji[] = [];
  const names = new Set<string>();
  let size = 0;
  for (const item of value) {
    const emoji = parseCustomEmoji(item);
    if (!emoji || names.has(emoji.name)) continue;
    const weight = emoji.kind === 'image' ? emoji.dataUrl.length : emoji.text.length;
    if (result.length >= 32 || size + weight > MAX_LIBRARY_CHARS) break;
    size += weight;
    names.add(emoji.name);
    result.push(emoji);
  }
  return result;
}

/**
 * Expands `:name:` tokens that name a text emoticon into its text — the
 * same text picking it from autocomplete or "My emoji" would have inserted
 * — so a hand-typed token is sent, and renders in our own messages, exactly
 * as it reads in the composer. Unknown names and image-emoji names are left
 * untouched as plain `:name:` text; delivering an *image* emoji alongside
 * the message is SendService.buildCustomEmoji's job, not this function's.
 *
 * Must run before markdown/mention ranges are computed over the body (an
 * expansion changes body length, which would otherwise shift them): pass
 * `escape` to re-escape the inserted text against that following markdown
 * pass, so characters inside it (e.g. the underscores in `¯\_(ツ)_/¯`) can't
 * be mistaken for syntax the user never typed. Omit it when the body isn't
 * going through markdown at all.
 */
export function expandTextEmoticons(
  text: string,
  library: readonly CustomEmoji[],
  escape?: (text: string) => string,
): string {
  if (!text.includes(':')) return text;
  const byName = new Map(
    library.filter(isTextCustomEmoji).map((emoji) => [emoji.name, emoji.text]),
  );
  if (byName.size === 0) return text;
  return text.replace(CUSTOM_EMOJI_TOKEN, (token, name: string) => {
    const value = byName.get(name);
    if (value === undefined) return token;
    return escape ? escape(value) : value;
  });
}
