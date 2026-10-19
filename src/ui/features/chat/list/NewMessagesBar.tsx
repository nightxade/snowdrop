import { CheckCheck } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { formatClock, type ConversationId } from '@/core/domain';
import { conversationsSelectors, sessionSelectors, uiSelectors } from '@/core/stores';
import { useShellStyle, useSnowdrop } from '@/ui/hooks';
import styles from './Overlays.module.css';

/**
 * "N new messages since 14:02 · Mark as read" across the top while the
 * unread divider is above the view (or not loaded). Counts what was unread
 * when the conversation was opened.
 *
 * In TUI this is a small top-right chip (`[12 new ↓] │ mark read`), not a
 * full-width bar: the standard-shell `.bar` is already inset by
 * `--snowdrop-space-7` left/right rather than edge-to-edge, but that's still
 * most of the pane's width (the same mistake the jump-to-present pill had —
 * see overlays.css); `.bar`'s own left/right are overridden there instead of
 * adding a wrapper.
 */
export function NewMessagesBar({
  conversationId,
  dividerLoaded,
  dividerAbove,
  dividerVisible,
  onJump,
}: {
  conversationId: ConversationId;
  dividerLoaded: boolean;
  dividerAbove: boolean;
  dividerVisible: boolean;
  onJump: () => void;
}) {
  const { stores, sync } = useSnowdrop();
  const marker = useStore(stores.ui, uiSelectors.unreadMarker(conversationId));
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const [count] = useState(
    () => conversationsSelectors.unread(conversationId)(stores.conversations.getState()).count,
  );
  const unreadNow = useStore(
    stores.conversations,
    (s) => conversationsSelectors.unread(conversationId)(s).count,
  );
  // "Mark as read" hides it; having seen the divider hides it only while
  // nothing is unread (new arrivals bring it back).
  const [dismissed, setDismissed] = useState(false);
  const [seen, setSeen] = useState(false);
  const tui = useShellStyle();
  if (dividerVisible && !seen) setSeen(true);
  const since = useStore(stores.messages, (s) => {
    const w = s.windows[conversationId];
    if (!w || marker === undefined) return undefined;
    for (const id of w.ids) {
      const m = w.byId[id];
      if (m?.seq !== undefined && m.seq > marker && m.authorId !== selfId && m.kind === 'normal')
        return m.sentAt;
    }
    return undefined;
  });

  const show =
    !dismissed &&
    count > 0 &&
    marker !== undefined &&
    (dividerAbove || !dividerLoaded) &&
    (!seen || unreadNow > 0);
  if (!show) return null;
  return (
    <div className={styles.bar} role="status" data-snowdrop="new-messages-bar">
      <button type="button" className={styles.barJump} onClick={onJump}>
        {tui ? (
          `[${count > 99 ? '99+' : count} new ↓]`
        ) : (
          <>
            {count > 99 ? '99+' : count} new message{count === 1 ? '' : 's'}
            {since !== undefined && dividerLoaded && ` since ${formatClock(since, { clock24h })}`}
          </>
        )}
      </button>
      {tui && (
        <span aria-hidden="true" className={styles.barSep}>
          │
        </span>
      )}
      <button
        type="button"
        className={styles.barRead}
        onClick={() => {
          setDismissed(true);
          void sync.markConversationRead(conversationId);
        }}
      >
        {tui ? (
          'mark read'
        ) : (
          <>
            Mark as read
            <CheckCheck size={16} aria-hidden />
          </>
        )}
      </button>
    </div>
  );
}
