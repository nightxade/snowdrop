import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { overlayOwnsKeys, useHandOffFocus } from '@/ui/hooks';
import { Drawer } from '@/ui/primitives';
import { useChatController } from './ChatController';
import styles from './ConversationArea.module.css';

// Fetched the first time someone searches a conversation.
const SearchPanel = lazy(() =>
  import('./header/SearchPanel').then((m) => ({ default: m.SearchPanel })),
);

/** The search panel beside the conversation: inline when wide, a sheet when narrow. */
export function SearchSlot({
  conversationId,
  narrow,
}: {
  conversationId: ConversationId;
  narrow: boolean;
}) {
  const chat = useChatController();
  const conversation = useConversationView(conversationId);
  // What is typed lives here, not in the panel: the panel is a new mount when the window narrows
  // (page to sheet) or widens, and the text goes with the conversation it was typed in.
  const [typed, setTyped] = useState({ conversationId, query: '' });
  const query = typed.conversationId === conversationId ? typed.query : '';
  // Closed by the shortcut (or any command) with focus in the panel: as closing it with Esc does,
  // focus goes to the composer (the message list with Vim's navigation keys on). The narrow sheet
  // hands focus back itself.
  useHandOffFocus(
    '[data-snowdrop="search-panel"]',
    () => {
      chat.focusAfterPanel();
    },
    !narrow,
  );
  const close = () => {
    chat.setSearchOpen(false);
    chat.focusAfterPanel();
  };
  // Enter on the field (or a click on a result) moves focus onto the matching message, outside the
  // panel: Esc there still closes the search, until focus goes anywhere else.
  const revealed = useRef(false);
  const closeLatest = useRef(close);
  useEffect(() => {
    closeLatest.current = close;
  });
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const el = event.target;
      if (!(el instanceof Element) || !el.closest('[data-message-scroller]'))
        revealed.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !revealed.current) return;
      const active = document.activeElement;
      if (!active?.closest('[data-message-scroller]') || overlayOwnsKeys(document)) return;
      event.preventDefault();
      event.stopPropagation();
      revealed.current = false;
      closeLatest.current();
    };
    document.addEventListener('focusin', onFocusIn, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, []);
  if (!conversation) return null;
  const panel = (
    <Suspense fallback={null}>
      <SearchPanel
        key={conversationId}
        conversation={conversation}
        query={query}
        onQueryChange={(next) => {
          setTyped({ conversationId, query: next });
        }}
        onClose={close}
        onReveal={(messageId) => {
          revealed.current = true;
          void chat.reveal(conversationId, messageId, { focus: true });
        }}
      />
    </Suspense>
  );
  if (!narrow)
    return (
      <div className={styles.side} data-tui-flatten>
        {panel}
      </div>
    );
  return (
    <Drawer
      side="right"
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
      label="Search"
    >
      {panel}
    </Drawer>
  );
}
