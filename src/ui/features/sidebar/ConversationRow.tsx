import { BellOff, Ellipsis, Hash, AtSign, Pin, X } from 'lucide-react';
import { memo, useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { startConversationDrag, useSnowdrop } from '@/ui/hooks';
import {
  archive,
  ConversationAvatar,
  openConversation,
  useConversationMenu,
  useMessageRequestState,
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
  /** Can be dragged onto a rail tile or another category. */
  draggable?: boolean;
}

export const ConversationRow = memo(function ConversationRow({
  id,
  variant,
  selected,
  tabStop,
  draggable = false,
}: ConversationRowProps) {
  const app = useSnowdrop();
  const [dragging, setDragging] = useState(false);
  const { view, unread, muted, typing, preview } = useRowState(id, variant === 'home');
  const menu = useConversationMenu(id);
  const requestState = useMessageRequestState(id);
  if (!view) return null;

  const hasUnread = unread.count > 0 && !muted;
  const mentions = unread.mentions;
  const Glyph = view.kind === 'group' ? Hash : AtSign;
  // A message request says so instead of showing what the stranger wrote.
  const secondary =
    typing ??
    (requestState === 'request'
      ? 'Message request'
      : requestState === 'blocked'
        ? 'Blocked'
        : preview);
  const label = [
    view.title,
    requestState === 'request' ? 'message request' : requestState === 'blocked' ? 'blocked' : '',
    mentions > 0 ? `${mentions} mention${mentions === 1 ? '' : 's'}` : hasUnread ? 'unread' : '',
    muted ? 'muted' : '',
    view.pinned ? 'pinned' : '',
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
      data-pinned={view.pinned ? '' : undefined}
      data-request={requestState === 'request' ? '' : undefined}
      data-blocked={requestState === 'blocked' ? '' : undefined}
      data-snowdrop="conversation-row"
      data-row-id={id}
      data-dragging={dragging ? '' : undefined}
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
          draggable={draggable || undefined}
          onDragStart={
            draggable
              ? (e) => {
                  startConversationDrag(e, id);
                  setDragging(true);
                }
              : undefined
          }
          onDragEnd={
            draggable
              ? () => {
                  setDragging(false);
                }
              : undefined
          }
          onClick={(e) => {
            // WebKitGTK doesn't focus a button on click (unlike other
            // engines): without this, roving focus and arrow-key stepping
            // would silently stop following the clicked row.
            e.currentTarget.focus();
            openConversation(app, id);
          }}
        >
          {variant === 'home' ? (
            <ConversationAvatar conversation={view} size={32} />
          ) : (
            <Glyph className={styles.glyph} size={18} aria-hidden />
          )}
          <span className={styles.text}>
            <span className={styles.titleRow}>
              {view.pinned && <Pin className={styles.pinIcon} size={12} aria-hidden />}
              <span className={styles.title}>{view.title}</span>
            </span>
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
        {/* ⋯ makes the row menu (Move to space / category, mute…) discoverable without right-click. */}
        <DropdownMenu entries={menu} align="start" side="right" label={`${view.title} options`}>
          <IconButton size="sm" label="More options" icon={<Ellipsis />} tabIndex={-1} />
        </DropdownMenu>
        {variant === 'home' && (
          <IconButton
            size="sm"
            label="Archive"
            icon={<X />}
            tabIndex={-1}
            onClick={() => {
              archive(app, id, true);
            }}
          />
        )}
      </span>
    </li>
  );
});
