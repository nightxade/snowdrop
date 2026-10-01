import { useState } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { uiSelectors } from '@/core/stores';
import { useKeybindLabel, useShellLayout, useStores } from '@/ui/hooks';
import { MembersPanel } from '@/ui/features/members';
import { Drawer, HearthMark, Kbd } from '@/ui/primitives';
import { ChatHeader } from './ChatHeader';
import { ChatController, ChatControllerProvider, useSearchOpen } from './ChatController';
import { ConversationArea } from './ConversationArea';
import { SearchSlot } from './SearchSlot';
import { ConnectionBanner } from './ConnectionBanner';
import { useChatCommands } from './useChatCommands';
import styles from './ChatColumn.module.css';

/**
 * Header across the top; below it the conversation (messages + composer)
 * and, for groups, the member list: inline when wide, a modal sheet when
 * narrow. Subscribes only to the selected id, its kind and the member-list
 * flag; each part subscribes to what it renders (PLAN §8, P2 review).
 */
export function ChatColumn() {
  // One controller per column: lets header, commands, list and composer drive each other.
  const [chat] = useState(() => new ChatController());
  return (
    <ChatControllerProvider value={chat}>
      <ChatColumnInner />
    </ChatControllerProvider>
  );
}

function ChatColumnInner() {
  const stores = useStores();
  useChatCommands();
  const searchOpen = useSearchOpen();
  const { narrow, drawer } = useShellLayout();
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const kind = useStore(stores.conversations, (s) =>
    selected ? s.byId[selected]?.kind : undefined,
  );
  const membersOpen = useStore(stores.ui, uiSelectors.memberListOpen);
  const showSearch = searchOpen && kind !== undefined && selected !== null;
  const showMembers = !showSearch && kind === 'group' && membersOpen && selected !== null;
  const closeMembers = () => {
    stores.ui.getState().toggleMemberList(false);
  };

  return (
    <main className={styles.column} data-hearth="chat" aria-label="Chat">
      {/* With nothing open the header would be an empty bar; keep it only for the drawer button. */}
      {(kind ?? drawer) && <ChatHeader conversationId={kind ? selected : null} />}
      <ConnectionBanner />
      <div className={styles.body}>
        <div className={styles.conversation}>
          {selected && kind ? (
            <>
              <ConversationArea key={selected} conversationId={selected} />
            </>
          ) : (
            <NothingOpen />
          )}
        </div>
        {showSearch && <SearchSlot conversationId={selected} narrow={narrow} />}
        {showMembers &&
          (narrow ? (
            <Drawer
              side="right"
              open
              onOpenChange={(open) => {
                if (!open) closeMembers();
              }}
              label="Members"
            >
              <MembersPanel conversationId={selected} onClose={closeMembers} />
            </Drawer>
          ) : (
            <div className={styles.members}>
              <MembersPanel conversationId={selected} />
            </div>
          ))}
      </div>
    </main>
  );
}

function NothingOpen() {
  const switcher = useKeybindLabel(CoreCommand.QuickSwitcher);
  const next = useKeybindLabel(CoreCommand.NextUnread);
  return (
    <div className={styles.empty}>
      <HearthMark size={56} className={styles.mark} />
      <p className={styles.emptyTitle}>Pick a conversation</p>
      <p className={styles.emptyBody}>Choose one from the list, or jump straight to one.</p>
      <dl className={styles.shortcuts}>
        {switcher && (
          <div>
            <dt>Find a conversation</dt>
            <dd>
              <Kbd combo={switcher} />
            </dd>
          </div>
        )}
        {next && (
          <div>
            <dt>Next unread</dt>
            <dd>
              <Kbd combo={next} />
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}
