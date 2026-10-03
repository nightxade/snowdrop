import { BellRing } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { Message } from '@/core/domain';
import { Tooltip } from '@/ui/primitives';
import styles from './plugins.module.css';

const HIGHLIGHT = 'snowdrop-keyword';

/**
 * The matched words get a dotted accent underline through the CSS Custom
 * Highlight API (no DOM changes, no row tint): our own look, not a mention.
 */
export const KEYWORD_HIGHLIGHT_CSS = `::highlight(${HIGHLIGHT}) { text-decoration: underline dotted var(--snowdrop-accent-text); text-decoration-thickness: 2px; text-underline-offset: 3px; }`;

interface HighlightRegistry {
  get(name: string): { add(range: Range): void; delete(range: Range): void } | undefined;
  set(name: string, highlight: unknown): void;
}

function registry(): { highlights: HighlightRegistry; create: () => unknown } | null {
  const css = (globalThis as { CSS?: { highlights?: HighlightRegistry } }).CSS;
  const Ctor = (globalThis as { Highlight?: new () => unknown }).Highlight;
  return css?.highlights && Ctor ? { highlights: css.highlights, create: () => new Ctor() } : null;
}

/** Ranges of every whole-word occurrence of `keyword` in the text under `root`. */
function keywordRanges(root: Node, keyword: string): Range[] {
  const needle = keyword.toLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const word = /[\p{L}\p{N}]/u;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = (node.nodeValue ?? '').toLowerCase();
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
      const before = text.charAt(at - 1);
      const after = text.charAt(at + needle.length);
      if ((before && word.test(before)) || (after && word.test(after))) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/** Keyword Alerts' decoration: a chip naming the keyword, and the underline in the body. */
export function makeKeywordChip(matcher: (message: Message) => string | null) {
  return function KeywordChip({ message }: { message: Message }) {
    const hit = matcher(message);
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
      const reg = registry();
      const row = ref.current?.closest('[data-snowdrop="message"]');
      const body = row?.querySelector('[data-snowdrop="message-body"]');
      if (!reg || !hit || !body) return;
      let highlight = reg.highlights.get(HIGHLIGHT);
      if (!highlight) {
        reg.highlights.set(HIGHLIGHT, reg.create());
        highlight = reg.highlights.get(HIGHLIGHT);
      }
      const ranges = keywordRanges(body, hit);
      for (const r of ranges) highlight?.add(r);
      return () => {
        for (const r of ranges) highlight?.delete(r);
      };
    }, [hit, message.body]);
    if (!hit) return null;
    return (
      <Tooltip label={`Matches your keyword “${hit}”`}>
        <span ref={ref} className={styles.keyword} data-keyword-hit="" tabIndex={0}>
          <BellRing size={11} aria-hidden />
          {hit}
        </span>
      </Tooltip>
    );
  };
}
