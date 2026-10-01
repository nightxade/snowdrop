import { BellOff, Hash, AtSign, Settings, X } from 'lucide-react';
import { memo } from 'react';
import type { ConversationId } from '@/core/domain';
import { useHearth } from '@/ui/hooks';
import {
  archive,
  ConversationAvatar,
  openConversation,
  useConversationMenu,
} from '@/ui/features/conversation';
import { Badge, ContextMenu, DropdownMenu, IconButton, TypingDots } from '@/ui/primitives';
import { useRowState } from './useRowState';
import styles from './ConversationRow.module.css';

export interface ConversationRowProps {
  id: ConversationId;
  /** 'home' = avatar + preview (40px); 'channel' = glyph + title (32px) inside a space. */
  variant: 'home' | 'channel';
  selected: boolean;
  /** The row that receives Tab focus in the list (roving tabindex). */
  tabStop: boolean;
}

export const ConversationRow = memo(function ConversationRow({
  id,
  variant,
  selected,
  tabStop,
}: ConversationRowProps) {
  const app = useHearth();
  const { view, unread, muted, typing, preview } = useRowState(id, variant === 'home');
  const menu = useConversationMenu(id);
  if (!view) return null;

  const hasUnread = unread.count > 0 && !muted;
  const mentions = unread.mentions;
  const Glyph = view.kind === 'group' ? Hash : AtSign;
  const secondary = typing ?? preview;
  const label = [
    view.title,
    mentions > 0 ? `${mentions} mention${mentions === 1 ? '' : 's'}` : hasUnread ? 'unread' : '',
    muted ? 'muted' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <li
      className={styles.row}
      data-variant={variant}
      data-selected={selected ? '' : undefined}
      data-unread={hasUnread ? '' : undefined}
      data-muted={muted ? '' : undefined}
      data-hearth="conversation-row"
    >
      <ContextMenu entries={menu} label={`${view.title} options`}>
        <button
          type="button"
          className={styles.main}
          data-roving-item
          data-conversation-id={id}
          tabIndex={tabStop ? 0 : -1}
          aria-current={selected ? 'page' : undefined}
          aria-label={label}
          onClick={() => {
            openConversation(app, id);
          }}
        >
          {variant === 'home' ? (
            <ConversationAvatar conversation={view} size={32} />
          ) : (
            <Glyph className={styles.glyph} size={18} aria-hidden />
          )}
          <span className={styles.text}>
            <span className={styles.title}>{view.title}</span>
            {variant === 'home' && secondary && (
              <span className={styles.preview} data-typing={typing ? '' : undefined}>
                {typing && <TypingDots />}
                <span className={styles.previewText}>{secondary}</span>
              </span>
            )}
          </span>
          {muted && variant === 'channel' && (
            <BellOff className={styles.mutedIcon} size={14} aria-hidden />
          )}
          <Badge variant="mention" count={mentions} className={styles.badge} />
        </button>
      </ContextMenu>
      <span className={styles.actions}>
        {variant === 'home' ? (
          <IconButton
            size="sm"
            label="Archive"
            icon={<X />}
            tabIndex={-1}
            onClick={() => {
              archive(app, id, true);
            }}
          />
        ) : (
          <DropdownMenu entries={menu} align="start" side="right" label={`${view.title} options`}>
            <IconButton size="sm" label="Options" icon={<Settings />} tabIndex={-1} />
          </DropdownMenu>
        )}
      </span>
    </li>
  );
});
