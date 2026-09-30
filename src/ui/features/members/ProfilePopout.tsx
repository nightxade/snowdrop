import { MessageSquare, ShieldCheck } from 'lucide-react';
import { useId, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import {
  directConversationId,
  initialsFor,
  type Contact,
  type ConversationId,
} from '@/core/domain';
import { HOME, localSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { copyText } from '@/ui/features/conversation';
import { Avatar, Button } from '@/ui/primitives';
import styles from './ProfilePopout.module.css';

export function safetyNumberHint(name: string): string {
  return `To verify ${name}, open your chat with them in the Signal app on your phone, tap their name, then “View safety number”, and compare it with theirs in person or over a call.`;
}

/** Profile card anchored to a member row (PLAN §4.7). The note is local-only and persisted. */
export function ProfilePopout({
  contact,
  onClose,
}: {
  contact: Contact;
  conversationId: ConversationId;
  onClose: () => void;
}) {
  const app = useHearth();
  const { stores } = app;
  const note = useStore(stores.local, localSelectors.note(contact.id));
  const dm = directConversationId(contact.id);
  const hasDm = useStore(stores.conversations, (s) => dm in s.byId);
  const noteId = useId();
  const showProfileName = contact.profileName && contact.profileName !== contact.name;

  return (
    <div className={styles.card} style={{ '--banner': contact.color } as CSSProperties}>
      <div className={styles.banner} />
      <span className={styles.avatar}>
        <Avatar
          src={contact.avatarUrl}
          fallback={initialsFor(contact.name)}
          color={contact.color}
          size={80}
        />
      </span>
      <div className={styles.body}>
        <div className={styles.names}>
          <p className={styles.name}>{contact.name}</p>
          {showProfileName && <p className={styles.profileName}>{contact.profileName}</p>}
        </div>
        {(contact.about ?? contact.aboutEmoji) && (
          <p className={styles.about}>
            {contact.aboutEmoji && <span aria-hidden>{contact.aboutEmoji} </span>}
            {contact.about}
          </p>
        )}
        {contact.number && (
          <dl className={styles.facts}>
            <dt>Phone</dt>
            <dd>{contact.number}</dd>
          </dl>
        )}
        {!contact.isSelf && (
          <div className={styles.actions}>
            <Button
              variant="primary"
              fullWidth
              icon={<MessageSquare size={16} />}
              disabled={!hasDm}
              title={hasDm ? undefined : 'You don’t have a direct conversation with them yet'}
              onClick={() => {
                stores.ui.getState().selectConversation(dm, HOME);
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
            placeholder="Click to add a note"
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
