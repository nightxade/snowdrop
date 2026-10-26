import { memo, useCallback, useRef, type CSSProperties } from 'react';
import {
  initialsFor,
  type Contact,
  type ConversationId,
  type GroupMemberLabel,
} from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Avatar, ContextMenu } from '@/ui/primitives';
import { memberMenu } from './memberMenu';
import { ProfileTrigger } from './ProfileTrigger';
import styles from './MemberRow.module.css';

export const MemberRow = memo(function MemberRow({
  contact,
  conversationId,
  tabStop,
  label,
}: {
  contact: Contact;
  conversationId: ConversationId;
  tabStop: boolean;
  /** The member's label in this group (Signal's "member label"), if they set one. */
  label?: GroupMemberLabel | undefined;
}) {
  const app = useSnowdrop();
  const button = useRef<HTMLButtonElement | null>(null);
  const menu = useCallback(
    () =>
      memberMenu(app, contact, conversationId, () => {
        // After the menu has closed and handed focus back to the row.
        requestAnimationFrame(() => button.current?.click());
      }),
    [app, contact, conversationId],
  );
  return (
    <li className={styles.item}>
      <ProfileTrigger
        contact={contact}
        conversationId={conversationId}
        side="left"
        sideOffset={12}
        trigger={
          <ContextMenu entries={menu} label={`${contact.name} options`}>
            <button
              ref={button}
              type="button"
              className={styles.row}
              data-roving-item
              tabIndex={tabStop ? 0 : -1}
              data-snowdrop="member-row"
            >
              <Avatar
                src={contact.avatarUrl}
                fallback={initialsFor(contact.name)}
                color={contact.color}
                size={32}
              />
              <span
                className={styles.name}
                style={{ '--name-color': contact.color } as CSSProperties}
              >
                {contact.name}
                {contact.isSelf && <span className={styles.you}> (you)</span>}
              </span>
              {label && (
                <span className={styles.label}>
                  {label.emoji && <span aria-hidden>{label.emoji} </span>}
                  {label.label}
                </span>
              )}
              {contact.aboutEmoji && (
                <span className={styles.emoji} aria-label={contact.about ?? undefined}>
                  {contact.aboutEmoji}
                </span>
              )}
            </button>
          </ContextMenu>
        }
      />
    </li>
  );
});
