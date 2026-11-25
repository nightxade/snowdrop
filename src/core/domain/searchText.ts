/**
 * What a search compares: text folded for matching (case, diacritics and Unicode normal forms
 * ignored) and a message's text as it reads on screen (mention names in place of their
 * placeholders). The persistence layer matches with these, and the result lists highlight with
 * them, so a hit is found and marked on the same text.
 */
import { MENTION_PLACEHOLDER, type Message } from './types';

/** Combining diacritical marks: stripped after decomposing, so "é" folds to "e". */
const COMBINING = /[̀-ͯ]/gu;
const ASCII = /^[^\u{80}-\u{10ffff}]*$/u;

const folded = new Map<string, string>();
/** Bound on `folded`: a long-running session meeting many distinct characters stays small. */
const FOLDED_LIMIT = 4096;

/** One code point folded: decomposed, its diacritics dropped, lowercased. */
function foldCodePoint(cp: string): string {
  if (cp.length === 1 && cp < '\u0080') return cp.toLowerCase();
  let out = folded.get(cp);
  if (out === undefined) {
    out = cp.normalize('NFD').replace(COMBINING, '').toLowerCase();
    if (folded.size >= FOLDED_LIMIT) folded.clear();
    folded.set(cp, out);
  }
  return out;
}

/**
 * `text` for matching: lowercase, diacritics gone, and the same whether it was typed composed or
 * decomposed ("cafe" finds "Café", "résumé" and "résumé" find each other). Folded one
 * code point at a time, so `foldWithMap` can say where each piece of the result came from.
 */
export function foldText(text: string): string {
  if (ASCII.test(text)) return text.toLowerCase();
  let out = '';
  for (const cp of text) out += foldCodePoint(cp);
  return out;
}

/** `foldText` of `text`, and for each UTF-16 unit of the result where it came from in `text`. */
export function foldWithMap(text: string): { folded: string; from: number[]; to: number[] } {
  let out = '';
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  for (const cp of text) {
    const piece = foldCodePoint(cp);
    // A dropped mark (an accent) belongs to the letter before it: marking that letter marks it.
    if (piece === '' && to.length > 0) {
      const lastFrom = from[from.length - 1];
      for (let i = to.length - 1; i >= 0 && from[i] === lastFrom; i--) to[i] = at + cp.length;
    }
    for (let i = 0; i < piece.length; i++) {
      from.push(at);
      to.push(at + cp.length);
    }
    out += piece;
    at += cp.length;
  }
  return { folded: out, from, to };
}

/** The words of a query, folded: what a message must contain, each of them, to match. */
export function foldedTerms(query: string): string[] {
  return foldText(query)
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}

/**
 * What a message reads as: its body with each mention's placeholder replaced by `@name`, or a
 * poll's question when it has no body. Without `nameFor` a mention is left as it is stored.
 */
export function displayedText(
  message: Pick<Message, 'body' | 'ranges' | 'poll'>,
  nameFor?: (id: string) => string,
): string {
  if (message.body === '' && message.poll) return message.poll.question;
  let text = message.body;
  if (!nameFor || !text.includes(MENTION_PLACEHOLDER)) return text;
  const mentions = message.ranges
    .filter((r) => r.mentionId !== undefined && text.charAt(r.start) === MENTION_PLACEHOLDER)
    .sort((a, b) => b.start - a.start);
  for (const r of mentions) {
    text = `${text.slice(0, r.start)}@${nameFor(r.mentionId ?? '')}${text.slice(r.start + 1)}`;
  }
  return text;
}
