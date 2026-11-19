import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import type { ConversationId } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { useHandOffWhenGone, useKeybindLabel, useShellLayout, useStores } from '@/ui/hooks';
import { MembersPanel } from '@/ui/features/members';
import { AreaErrorBoundary } from '@/ui/lib/AreaErrorBoundary';
import { Drawer, Kbd, SnowdropMark } from '@/ui/primitives';
import { ChatHeader } from './ChatHeader';
import {
  ChatController,
  ChatControllerProvider,
  useChatController,
  useGalleryOpen,
  useSearchOpen,
} from './ChatController';
import { ConversationArea } from './ConversationArea';
import { GallerySlot } from './GallerySlot';
import { SearchSlot } from './SearchSlot';
import { ConnectionBanner } from './ConnectionBanner';
import { MiniPlayer } from './voice/MiniPlayer';
import { useChatCommands } from './useChatCommands';
import { useReleaseMarkedUnread } from './useReleaseMarkedUnread';
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
  const galleryOpen = useGalleryOpen();
  const chat = useChatController();
  // A jump asked for from outside the column (global search): the open
  // conversation's list reveals it, or, once its list mounts, the new one's.
  const revealRequest = useStore(stores.ui, uiSelectors.revealRequest);
  useEffect(() => {
    if (!revealRequest) return;
    stores.ui.getState().clearRevealRequest();
    void chat.reveal(revealRequest.conversationId, revealRequest.messageId, { focus: true });
  }, [revealRequest, chat, stores]);
  const { narrow, drawer } = useShellLayout();
  const selected = useStore(stores.ui, uiSelectors.selectedConversation);
  const kind = useStore(stores.conversations, (s) =>
    selected ? s.byId[selected]?.kind : undefined,
  );
  // TUI shell only: the chat pane's border carries the open conversation's
  // name (a real element, hidden outside the TUI shell; see tui.css).
  const title = useStore(stores.conversations, (s) =>
    selected ? s.byId[selected]?.title : undefined,
  );
  const membersOpen = useStore(stores.ui, uiSelectors.memberListOpen);
  const column = useRef<HTMLElement | null>(null);
  useReleaseMarkedUnread(column, selected);
  // The open conversation went (deleted on the phone) with focus in its pane: focus goes to the
  // fallback (M15), not the page.
  useHandOffWhenGone({
    identify: (el) => (el.closest('[data-snowdrop="chat"]') ? (selected ?? null) : null),
    stillThere: (id) => stores.conversations.getState().byId[id as ConversationId] !== undefined,
  });

  const showSearch = searchOpen && kind !== undefined && selected !== null;
  const showGallery = galleryOpen && !showSearch && kind !== undefined && selected !== null;
  const showMembers =
    !showSearch && !showGallery && kind === 'group' && membersOpen && selected !== null;
  const closeMembers = () => {
    stores.ui.getState().toggleMemberList(false);
  };

  return (
    <main ref={column} className={styles.column} data-snowdrop="chat" aria-label="Chat">
      {/* aria-hidden: the conversation's name is already the chat header's
          own heading; this is only the TUI shell's border title. */}
      <span className={styles.titleTag} data-snowdrop="chat-title-tag" aria-hidden="true">
        {title ?? 'chat'}
      </span>
      {/* Each strip has its own boundary, so a failing global widget (the player, the
          banner) cannot take the conversation down with it. */}
      {/* With nothing open the header would be an empty bar; keep it only for the drawer button. */}
      {(kind ?? drawer) && (
        <AreaErrorBoundary area="the chat header" resetKeys={[selected]} compact>
          <ChatHeader conversationId={kind ? selected : null} />
        </AreaErrorBoundary>
      )}
      <AreaErrorBoundary area="the voice player" compact>
        <MiniPlayer />
      </AreaErrorBoundary>
      <AreaErrorBoundary area="the connection banner" compact>
        <ConnectionBanner />
      </AreaErrorBoundary>
      <AreaErrorBoundary area="the chat" resetKeys={[selected]}>
        {/* data-tui-flatten (tui.css): in the TUI shell these wrappers collapse
          (display: contents) so the message pane, composer and members panel
          become direct grid items of `.column` instead of nested boxes — the
          standard shell's flex layout is unaffected. */}
        <div className={styles.body} data-tui-flatten>
          <div className={styles.conversation} data-tui-flatten>
            {selected && kind ? (
              <>
                <ConversationArea key={selected} conversationId={selected} />
              </>
            ) : (
              <NothingOpen />
            )}
          </div>
          {showSearch && <SearchSlot conversationId={selected} narrow={narrow} />}
          {showGallery && <GallerySlot conversationId={selected} narrow={narrow} />}
          {showMembers &&
            (narrow ? (
              <Drawer
                side="right"
                open
                onOpenChange={(open) => {
                  if (!open) closeMembers();
                }}
                label="Members"
                returnFocus={memberToggle}
              >
                <AreaErrorBoundary area="the members" resetKeys={[selected]}>
                  <MembersPanel conversationId={selected} onClose={closeMembers} />
                </AreaErrorBoundary>
              </Drawer>
            ) : (
              <div className={styles.members} data-tui-flatten>
                <AreaErrorBoundary area="the members" resetKeys={[selected]}>
                  <MembersPanel conversationId={selected} />
                </AreaErrorBoundary>
              </div>
            ))}
        </div>
      </AreaErrorBoundary>
    </main>
  );
}

const memberToggle = () => document.querySelector<HTMLElement>('[data-snowdrop="member-toggle"]');

function NothingOpen() {
  const switcher = useKeybindLabel(CoreCommand.QuickSwitcher);
  const next = useKeybindLabel(CoreCommand.NextUnread);
  return (
    <div className={styles.empty} data-snowdrop="message-pane">
      <SnowdropMark size={56} className={styles.mark} />
      <h1 className={styles.emptyTitle}>Pick a conversation</h1>
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
