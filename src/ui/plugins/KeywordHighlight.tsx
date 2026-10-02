import { BellRing } from 'lucide-react';
import type { Message } from '@/core/domain';
import { Tooltip } from '@/ui/primitives';
import styles from './plugins.module.css';

/** Tints rows carrying the chip (the decoration is the hook; :has keeps it CSS-only). */
export const KEYWORD_HIGHLIGHT_CSS = `[data-shrike='message']:has([data-keyword-hit]) { background: var(--shrike-highlight-bg); box-shadow: inset 2px 0 0 var(--shrike-warning); }`;

/** Keyword Alerts' decoration: a chip naming the matched keyword. */
export function makeKeywordChip(matcher: (message: Message) => string | null) {
  return function KeywordChip({ message }: { message: Message }) {
    const hit = matcher(message);
    if (!hit) return null;
    return (
      <Tooltip label={`Matches your keyword “${hit}”`}>
        <span className={styles.keyword} data-keyword-hit="" tabIndex={0}>
          <BellRing size={11} aria-hidden />
          {hit}
        </span>
      </Tooltip>
    );
  };
}
