import { MessageSquare, ShieldCheck } from 'lucide-react';
import { useId, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { initialsFor, type Contact, type ConversationId } from '@/core/domain';
import { localSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { copyText, formatPhone, openDirectConversation } from '@/ui/features/conversation';
import { Avatar, Button } from '@/ui/primitives';
import styles from './ProfilePopout.module.css';

export function safetyNumberHint(name: string): string {
  return `To verify ${name}, open your chat with them in the Signal app on your phone, tap their name, then “View safety number”, and compare it with theirs in person or over a call.`;
}

/**
 * Profile card for a contact (PLAN §4.7): identity on a header tinted with the
 * contact's colour, about, number, actions and a private note (local-only,
 * persisted). `conversationId` is the group it was opened from, if any, and
 * adds that group's role.
 */
export function ProfilePopout({
  contact,
  conversationId,
  onClose,
}: {
  contact: Contact;
  conversationId?: ConversationId | undefined;
  onClose: () => void;
}) {
  const app = useHearth();
  const { stores } = app;
  const note = useStore(stores.local, localSelectors.note(contact.id));
  const isAdmin = useStore(stores.conversations, (s) =>
    conversationId ? (s.byId[conversationId]?.adminIds.includes(contact.id) ?? false) : false,
  );
  const noteId = useId();
  const showProfileName = contact.profileName && contact.profileName !== contact.name;

  return (
    <div className={styles.card} style={{ '--tint': contact.color } as CSSProperties}>
      <header className={styles.header}>
        <Avatar
          src={contact.avatarUrl}
          fallback={initialsFor(contact.name)}
          color={contact.color}
          size={48}
        />
        <div className={styles.names}>
          <p className={styles.name}>{contact.name}</p>
          {showProfileName && <p className={styles.profileName}>{contact.profileName}</p>}
          {isAdmin && <span className={styles.role}>Group admin</span>}
        </div>
      </header>
      <div className={styles.body}>
        {(contact.about ?? contact.aboutEmoji) && (
          <p className={styles.about}>
            {contact.aboutEmoji && <span aria-hidden>{contact.aboutEmoji} </span>}
            {contact.about}
          </p>
        )}
        {contact.number && (
          <dl className={styles.facts}>
            <dt>Phone</dt>
            <dd>{formatPhone(contact.number)}</dd>
          </dl>
        )}
        {!contact.isSelf && (
          <div className={styles.actions}>
            <Button
              variant="primary"
              fullWidth
              icon={<MessageSquare size={16} />}
              onClick={() => {
                openDirectConversation(app, contact);
                onClose();
              }}
            >
              Message
            </Button>
            <Button
              variant="secondary"
              size="sm"
              fullWidth
              icon={<ShieldCheck size={14} />}
              onClick={() => {
                void copyText(app, safetyNumberHint(contact.name), 'safety-number steps');
              }}
            >
              Copy safety-number steps
            </Button>
          </div>
        )}
        <div className={styles.note}>
          <label htmlFor={noteId} className={styles.noteLabel}>
            Note <span className={styles.noteHint}>only on this device</span>
          </label>
          <textarea
            id={noteId}
            className={styles.noteInput}
            rows={2}
            maxLength={500}
            placeholder="Add a private note…"
            value={note}
            onChange={(e) => {
              stores.local.getState().setNote(contact.id, e.target.value);
            }}
          />
        </div>
      </div>
    </div>
  );
}
