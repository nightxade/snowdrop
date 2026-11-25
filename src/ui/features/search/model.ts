/** Pure helpers for the all-chats search results (snippets, highlighting). */
import { displayedText, foldedTerms, foldWithMap, type Message } from '@/core/domain';
import { matchesSearch, newestSentFirst } from '@/core/persistence';
import type { MessagesState } from '@/core/stores';

export interface SnippetPart {
  text: string;
  hit: boolean;
}

const WINDOW = 140;
const LEAD = 36;

/**
 * What a message reads as in a result: its body with each mention's
 * placeholder replaced by `@name`, or a poll's question. The text the
 * search itself matches (`displayedText`).
 */
export function resultText(message: Message, nameFor: (id: string) => string): string {
  return displayedText(message, nameFor);
}

/**
 * A one-line excerpt around the first match, with every term occurrence in
 * it flagged. Whitespace runs collapse; cut ends get an ellipsis. Terms are
 * found in the folded text (case and diacritics ignored) and the flagged
 * span is the original characters they came from.
 */
export function snippetParts(raw: string, terms: readonly string[]): SnippetPart[] {
  const text = raw.replace(/\s+/gu, ' ').trim();
  const { folded, from, to } = foldWithMap(text);
  // The span of `text` that folded[at, at + length) came from.
  const span = (at: number, length: number): [number, number] => [
    from[at] ?? text.length,
    to[at + length - 1] ?? text.length,
  ];
  let first = -1;
  for (const t of terms) {
    const at = folded.indexOf(t);
    if (at === -1) continue;
    const begin = span(at, t.length)[0];
    if (first === -1 || begin < first) first = begin;
  }
  let start = first > LEAD ? first - LEAD : 0;
  if (start > 0) {
    const space = text.indexOf(' ', start);
    if (space !== -1 && space < first) start = space + 1;
  }
  const end = Math.min(text.length, start + WINDOW);
  const marks = new Array<boolean>(end - start).fill(false);
  for (const t of terms) {
    if (t === '') continue;
    for (let at = folded.indexOf(t); at !== -1; at = folded.indexOf(t, at + 1)) {
      const [begin, finish] = span(at, t.length);
      if (begin >= end) break;
      for (let i = Math.max(begin, start); i < Math.min(end, finish); i++) marks[i - start] = true;
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

/** The words of a query, folded (case and diacritics ignored): what the repository matches on. */
export function queryTerms(query: string): string[] {
  return foldedTerms(query);
}

/** Every message the stores hold in memory: the loaded windows and each chat's newest message. */
export function messagesInMemory(
  windows: MessagesState['windows'],
  lastMessage: Record<string, Message>,
): Map<string, Message> {
  const all = new Map<string, Message>();
  for (const window of Object.values(windows))
    for (const m of Object.values(window.byId)) all.set(m.id, m);
  for (const m of Object.values(lastMessage)) if (!all.has(m.id)) all.set(m.id, m);
  return all;
}

/**
 * The results kept up to date from what the stores hold in memory, without searching storage
 * again: a result deleted or expired (`gone`), or edited so it no longer matches, leaves; an edited
 * one is replaced by its new version; a message in `changed` (new or edited since the results were
 * found) that matches joins, in sent-time order, and the list is cut to `limit`. A result the
 * stores do not hold (outside every loaded window) stays as it was. Returns `results` itself when
 * nothing changed.
 */
export function followMemory(
  results: readonly Message[],
  memory: ReadonlyMap<string, Message>,
  changed: readonly Message[],
  gone: Readonly<Record<string, true>>,
  terms: readonly string[],
  nameFor: (id: string) => string,
  limit: number,
): readonly Message[] {
  const next: Message[] = [];
  const have = new Set<string>();
  let differs = false;
  for (const r of results) {
    if (gone[r.id]) {
      differs = true;
      continue;
    }
    const m = memory.get(r.id) ?? r;
    if (!matchesSearch(m, terms, nameFor)) {
      differs = true;
      continue;
    }
    if (m !== r) differs = true;
    have.add(m.id);
    next.push(m);
  }
  for (const m of changed) {
    if (have.has(m.id) || gone[m.id] || !matchesSearch(m, terms, nameFor)) continue;
    have.add(m.id);
    next.push(m);
    differs = true;
  }
  if (!differs) return results;
  return next.sort(newestSentFirst).slice(0, limit);
}
