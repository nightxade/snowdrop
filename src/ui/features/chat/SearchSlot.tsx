import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { PanelArrival, PanelFocus } from './header/SearchPanel';
import type { ConversationId, MessageId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { overlayOwnsKeys, useHandOffFocus } from '@/ui/hooks';
import { Drawer } from '@/ui/primitives';
import { useChatController } from './ChatController';
import styles from './ConversationArea.module.css';

// Fetched when the app is idle after it has booted (`usePreloadSearchPanel`), so the first Ctrl+F
// of a session opens the panel at once and keeps the keys typed straight after it; at the latest
// when someone searches a conversation.
const loadSearchPanel = () =>
  import('./header/SearchPanel').then((m) => ({ default: m.SearchPanel }));
const SearchPanel = lazy(loadSearchPanel);

/** Requests the search panel's chunk once the browser is idle (the chat column mounts at boot). */
export function usePreloadSearchPanel(): void {
  useEffect(() => {
    const preload = () => {
      void loadSearchPanel();
    };
    if ('requestIdleCallback' in window) {
      const handle = window.requestIdleCallback(preload);
      return () => {
        window.cancelIdleCallback(handle);
      };
    }
    const timer = setTimeout(preload, 1500);
    return () => {
      clearTimeout(timer);
    };
  }, []);
}

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
  // What is typed lives in the controller, not in the panel: the panel is a new mount when the
  // window narrows (page to sheet) or widens, and a sheet closed by picking a result comes back
  // with the same query. It goes with the conversation it was typed in.
  const query = chat.searchQueryFor(conversationId);
  const [, setTyped] = useState(0);
  // Whether the panel has mounted before: the first mount is the user opening search (focus goes to
  // the field); later ones are the panel moving between the page and a sheet.
  const mounted = useRef(false);
  const opening = useRef(true);
  useEffect(() => {
    opening.current = false;
  }, []);
  // What had focus inside the panel, to put it on the same element when the panel moves.
  const held = useRef<PanelFocus | null>(null);
  const arrive = (): PanelArrival => {
    const opened = !mounted.current;
    mounted.current = true;
    return { opened, held: held.current };
  };
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
  // Below 1100 px the panel is a sheet over the chat: a result closes it so the message it
  // jumped to is in view, with focus on it; the query stays for when search is opened again.
  const picked = useRef<MessageId | null>(null);
  const pick = (messageId: MessageId) => {
    revealed.current = !narrow;
    if (narrow) {
      picked.current = messageId;
      chat.setSearchOpen(false, { keepQuery: true });
    }
    void chat.reveal(conversationId, messageId, { focus: true });
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
      held.current = describeFocus(el);
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
          chat.setSearchQuery(conversationId, next);
          setTyped((n) => n + 1);
        }}
        onClose={close}
        onReveal={pick}
        onArrive={arrive}
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
      autoFocus={() => opening.current}
      // Closed by picking a result: focus waits on the message list (the message itself when it is
      // already drawn) until the jump focuses the message, not on the button that opened the chat.
      closeTarget={() => {
        const id = picked.current;
        if (id === null) return undefined;
        return (
          document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) ??
          document.querySelector<HTMLElement>('[data-message-scroller]')
        );
      }}
      label="Search"
    >
      {panel}
    </Drawer>
  );
}

/** Which element of the panel `el` is, when it is one (focus moving elsewhere forgets it). */
function describeFocus(el: EventTarget | null): PanelFocus | null {
  if (!(el instanceof Element) || !el.closest('[data-snowdrop="search-panel"]')) return null;
  const result = el.closest('[data-search-result]');
  if (result) {
    const id = result.getAttribute('data-result-id');
    return id === null ? { kind: 'field' } : { kind: 'result', id };
  }
  if (el.closest('[aria-label^="Close search"]')) return { kind: 'close' };
  return { kind: 'field' };
}
