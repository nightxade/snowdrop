import { lazy, Suspense } from 'react';
import type { ConversationId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { useHandOffFocus } from '@/ui/hooks';
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
  // Closed by the shortcut (or any command) with focus in the panel: as closing it with Esc does,
  // focus goes to the composer. The narrow sheet hands focus back itself.
  useHandOffFocus(
    '[data-snowdrop="search-panel"]',
    () => {
      chat.focusComposer();
    },
    !narrow,
  );
  if (!conversation) return null;
  const close = () => {
    chat.setSearchOpen(false);
    chat.focusComposer();
  };
  const panel = (
    <Suspense fallback={null}>
      <SearchPanel key={conversationId} conversation={conversation} onClose={close} />
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
