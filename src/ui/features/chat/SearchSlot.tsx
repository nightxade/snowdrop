import type { ConversationId } from '@/core/domain';
import { useConversationView } from '@/ui/features/conversation';
import { Drawer } from '@/ui/primitives';
import { useChatController } from './ChatController';
import { SearchPanel } from './header/SearchPanel';
import styles from './ConversationArea.module.css';

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
  if (!conversation) return null;
  const close = () => {
    chat.setSearchOpen(false);
    chat.focusComposer();
  };
  const panel = <SearchPanel key={conversationId} conversation={conversation} onClose={close} />;
  if (!narrow) return <div className={styles.side}>{panel}</div>;
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
