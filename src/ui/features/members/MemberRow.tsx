import { memo, useState, type CSSProperties } from 'react';
import { initialsFor, type Contact, type ConversationId } from '@/core/domain';
import { Avatar, Popover } from '@/ui/primitives';
import { ProfilePopout } from './ProfilePopout';
import styles from './MemberRow.module.css';

export const MemberRow = memo(function MemberRow({
  contact,
  conversationId,
  tabStop,
}: {
  contact: Contact;
  conversationId: ConversationId;
  tabStop: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className={styles.item}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side="left"
        align="start"
        sideOffset={12}
        flush
        label={`${contact.name}'s profile`}
        trigger={
          <button
            type="button"
            className={styles.row}
            data-roving-item
            tabIndex={tabStop ? 0 : -1}
            data-hearth="member-row"
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
            {contact.aboutEmoji && (
              <span className={styles.emoji} aria-label={contact.about ?? undefined}>
                {contact.aboutEmoji}
              </span>
            )}
          </button>
        }
      >
        <ProfilePopout
          contact={contact}
          conversationId={conversationId}
          onClose={() => {
            setOpen(false);
          }}
        />
      </Popover>
    </li>
  );
});
