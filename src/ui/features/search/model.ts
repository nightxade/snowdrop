/** Pure helpers for the all-chats search results (snippets, highlighting). */
import { MENTION_PLACEHOLDER, type Message } from '@/core/domain';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

const WINDOW = 140;
const LEAD = 36;

/**
 * What a message reads as in a result: its body with each mention's
 * placeholder replaced by `@name`, or a poll's question.
 */
export function resultText(message: Message, nameFor: (id: string) => string): string {
  if (message.body === '' && message.poll) return message.poll.question;
  let text = message.body;
  const mentions = message.ranges
    .filter((r) => r.mentionId !== undefined && text.charAt(r.start) === MENTION_PLACEHOLDER)
    .sort((a, b) => b.start - a.start);
  for (const r of mentions) {
    text = `${text.slice(0, r.start)}@${nameFor(r.mentionId ?? '')}${text.slice(r.start + 1)}`;
  }
  return text;
}

/**
 * A one-line excerpt around the first match, with every term occurrence in
 * it flagged. Whitespace runs collapse; cut ends get an ellipsis.
 */
export function snippetParts(raw: string, terms: readonly string[]): SnippetPart[] {
  const text = raw.replace(/\s+/gu, ' ').trim();
  const lower = text.toLowerCase();
  // Case mapping can change a string's length; then offsets don't line up.
  const aligned = lower.length === text.length;
  let first = -1;
  if (aligned) {
    for (const t of terms) {
      const at = lower.indexOf(t);
      if (at !== -1 && (first === -1 || at < first)) first = at;
    }
  }
  let start = first > LEAD ? first - LEAD : 0;
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < first) start = space + 1;
  }
  const end = Math.min(text.length, start + WINDOW);
  const marks = new Array<boolean>(end - start).fill(false);
  if (aligned) {
    for (const t of terms) {
      for (let at = lower.indexOf(t, start); at !== -1 && at < end; at = lower.indexOf(t, at + 1)) {
        for (let i = at; i < Math.min(end, at + t.length); i++) marks[i - start] = true;
      }
    }
  }
  const parts: SnippetPart[] = [];
  if (start > 0) parts.push({ text: '…', hit: false });
  let run = '';
  let runHit = false;
  for (let i = start; i < end; i++) {
    const hit = marks[i - start] === true;
    if (hit !== runHit && run) {
      parts.push({ text: run, hit: runHit });
      run = '';
    }
    runHit = hit;
    run += text.charAt(i);
  }
  if (run) parts.push({ text: run, hit: runHit });
  if (end < text.length) parts.push({ text: '…', hit: false });
  return parts;
}

/** The words of a query, lowercased: what the repository matches on. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/u)
    .filter((t) => t.length > 0);
}
