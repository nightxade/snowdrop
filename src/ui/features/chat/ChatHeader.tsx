import { Hash, Menu, Search, Timer, Users } from 'lucide-react';
import { memo, useState } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { formatDuration, type ConversationId } from '@/core/domain';
import { isMuted, uiSelectors } from '@/core/stores';
import { useHearth, useKeybindLabel, useShellLayout } from '@/ui/hooks';
import { ConversationAvatar, useConversationView } from '@/ui/features/conversation';
import { Divider, IconButton, Popover, Tooltip } from '@/ui/primitives';
import { useSearchOpen } from './ChatController';
import { ConversationDetails } from './ConversationDetails';
import { MentionsInbox } from './header/MentionsInbox';
import { PinnedPopover } from './header/PinnedPopover';
import { PluginHeaderButtons } from './PluginHeaderButtons';
import styles from './ChatHeader.module.css';

/** Subscribes to its own conversation so the rest of the column doesn't re-render for header changes. */
export const ChatHeader = memo(function ChatHeader({
  conversationId,
}: {
  conversationId: ConversationId | null;
}) {
  const { stores, commands, send } = useHearth();
  const layout = useShellLayout();
  const searchOpen = useSearchOpen();
  const searchKey = useKeybindLabel(CoreCommand.SearchConversation);
  const conversation = useConversationView(conversationId);
  const membersOpen = useStore(stores.ui, uiSelectors.memberListOpen);
  const membersKey = useKeybindLabel(CoreCommand.ToggleMemberList);
  const [topicOpen, setTopicOpen] = useState(false);

  return (
    <header
      className={styles.header}
      data-hearth="chat-header"
      data-expanded={topicOpen ? '' : undefined}
    >
      {layout.drawer && (
        <NavButton
          current={conversationId}
          onOpen={() => {
            layout.setNavOpen(true);
          }}
        />
      )}
      {conversation && (
        <>
          <h1 className={styles.heading}>
            <Popover
              label={`About ${conversation.title}`}
              side="bottom"
              align="start"
              flush
              trigger={
                <button type="button" className={styles.title}>
                  {conversation.kind === 'direct' ? (
                    <ConversationAvatar conversation={conversation} size={24} />
                  ) : (
                    <Hash className={styles.glyph} size={20} aria-hidden />
                  )}
                  <span className={styles.titleText}>{conversation.title}</span>
                </button>
              }
            >
              <ConversationDetails conversation={conversation} />
            </Popover>
          </h1>
          {conversation.description && (
            <>
              <Divider orientation="vertical" className={styles.divider} />
              <button
                type="button"
                className={styles.topic}
                aria-expanded={topicOpen}
                aria-label={topicOpen ? 'Collapse topic' : `Topic: ${conversation.description}`}
                onClick={() => {
                  setTopicOpen((v) => !v);
                }}
              >
                {conversation.description}
              </button>
            </>
          )}
        </>
      )}
      <div className={styles.actions}>
        {conversation && conversation.expireTimerSec > 0 && (
          <Tooltip label={`Disappearing messages: ${formatDuration(conversation.expireTimerSec)}`}>
            <span
              className={styles.timer}
              role="img"
              aria-label={`Disappearing messages: ${formatDuration(conversation.expireTimerSec)}`}
              tabIndex={0}
            >
              <Timer size={16} aria-hidden />
              <span aria-hidden>{shortDuration(conversation.expireTimerSec)}</span>
            </span>
          </Tooltip>
        )}
        {conversation && send.capabilities.pin && <PinnedPopover conversation={conversation} />}
        {conversation && <PluginHeaderButtons conversation={conversation} />}
        {conversation?.kind === 'group' && (
          <IconButton
            label={membersOpen ? 'Hide member list' : 'Show member list'}
            icon={<Users />}
            active={membersOpen}
            data-hearth="member-toggle"
            {...(membersKey ? { shortcut: membersKey } : {})}
            onClick={() => {
              void commands.execute(CoreCommand.ToggleMemberList);
            }}
          />
        )}
        {conversation && (
          <IconButton
            label={searchOpen ? 'Close search' : 'Search this conversation'}
            icon={<Search />}
            active={searchOpen}
            tooltipSide="bottom"
            {...(searchKey ? { shortcut: searchKey } : {})}
            onClick={() => {
              void commands.execute(CoreCommand.SearchConversation);
            }}
          />
        )}
        <MentionsInbox />
      </div>
    </header>
  );
});

/**
 * The drawer button on small screens. A dot tells you something unread is
 * waiting elsewhere, since the rail and sidebar are out of sight.
 */
function NavButton({ current, onOpen }: { current: ConversationId | null; onOpen: () => void }) {
  const { stores } = useHearth();
  const waiting = useStore(stores.conversations, (s) => {
    const local = stores.local.getState().conversations;
    const now = Date.now();
    return Object.entries(s.unread).some(
      ([id, u]) =>
        id !== current &&
        (u.mentions > 0 ||
          (u.count > 0 && !isMuted(local[id as ConversationId]?.muted ?? false, now))),
    );
  });
  return (
    <span className={styles.nav}>
      <IconButton
        label={waiting ? 'Open navigation (unread messages)' : 'Open navigation'}
        icon={<Menu />}
        onClick={onOpen}
      />
      {waiting && <span className={styles.navDot} aria-hidden />}
    </span>
  );
}

/** "1w", "8h", "30s" for the compact timer chip; never rounds up past the real value. */
export function shortDuration(seconds: number): string {
  const units: [number, string][] = [
    [604_800, 'w'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ];
  for (const [size, suffix] of units)
    if (seconds >= size) return `${Math.floor(seconds / size)}${suffix}`;
  return `${seconds}s`;
}
