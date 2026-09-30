import { AtSign, Hash, Menu, Timer, Users } from 'lucide-react';
import { useState } from 'react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { formatDuration, type ConversationView } from '@/core/domain';
import { uiSelectors } from '@/core/stores';
import { useHearth, useKeybindLabel, useShellLayout } from '@/ui/hooks';
import { Divider, IconButton, Popover, Tooltip } from '@/ui/primitives';
import { ConversationDetails } from './ConversationDetails';
import { PluginHeaderButtons } from './PluginHeaderButtons';
import styles from './ChatHeader.module.css';

export function ChatHeader({ conversation }: { conversation: ConversationView | undefined }) {
  const { stores, commands } = useHearth();
  const layout = useShellLayout();
  const membersOpen = useStore(stores.ui, uiSelectors.memberListOpen);
  const membersKey = useKeybindLabel(CoreCommand.ToggleMemberList);
  const [topicOpen, setTopicOpen] = useState(false);
  const Glyph = conversation?.kind === 'direct' ? AtSign : Hash;

  return (
    <header
      className={styles.header}
      data-hearth="chat-header"
      data-expanded={topicOpen ? '' : undefined}
    >
      {layout.drawer && (
        <IconButton
          label="Open navigation"
          icon={<Menu />}
          onClick={() => {
            layout.setNavOpen(true);
          }}
        />
      )}
      {conversation && (
        <>
          <Popover
            label={`About ${conversation.title}`}
            side="bottom"
            align="start"
            flush
            trigger={
              <button type="button" className={styles.title}>
                <Glyph className={styles.glyph} size={20} aria-hidden />
                <h1 className={styles.titleText}>{conversation.title}</h1>
              </button>
            }
          >
            <ConversationDetails conversation={conversation} />
          </Popover>
          {conversation.description && (
            <>
              <Divider orientation="vertical" className={styles.divider} />
              <button
                type="button"
                className={styles.topic}
                aria-expanded={topicOpen}
                title={topicOpen ? undefined : conversation.description}
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
            <span className={styles.timer} tabIndex={0}>
              <Timer size={16} aria-hidden />
              <span>{shortDuration(conversation.expireTimerSec)}</span>
            </span>
          </Tooltip>
        )}
        {conversation && <PluginHeaderButtons conversation={conversation} />}
        {conversation?.kind === 'group' && (
          <IconButton
            label={membersOpen ? 'Hide member list' : 'Show member list'}
            icon={<Users />}
            active={membersOpen}
            {...(membersKey ? { shortcut: membersKey } : {})}
            onClick={() => {
              void commands.execute(CoreCommand.ToggleMemberList);
            }}
          />
        )}
      </div>
    </header>
  );
}

/** "1w", "8h", "30s" for the compact timer chip. */
function shortDuration(seconds: number): string {
  const units: [number, string][] = [
    [604_800, 'w'],
    [86_400, 'd'],
    [3_600, 'h'],
    [60, 'm'],
  ];
  for (const [size, suffix] of units)
    if (seconds >= size) return `${Math.round(seconds / size)}${suffix}`;
  return `${seconds}s`;
}
