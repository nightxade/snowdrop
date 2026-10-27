import { Ban, CircleSlash, MessageSquare, ShieldCheck } from 'lucide-react';
import { useId, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import {
  directConversationId,
  initialsFor,
  type Contact,
  type ConversationId,
} from '@/core/domain';
import { localSelectors } from '@/core/stores';
import { useObservableList, useSnowdrop } from '@/ui/hooks';
import {
  canBlock,
  formatPhone,
  openBlockDialog,
  openDirectConversation,
  PersonAvatar,
  pluginMenuEntries,
  useBlockTarget,
} from '@/ui/features/conversation';
import { canViewSafetyNumber, openSafetyNumber, VerifiedBadge } from '@/ui/features/safety';
import { Button } from '@/ui/primitives';
import styles from './ProfilePopout.module.css';

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
  variant = 'popout',
}: {
  contact: Contact;
  conversationId?: ConversationId | undefined;
  onClose: () => void;
  /** `sheet`: full width inside a bottom drawer (phones). */
  variant?: 'popout' | 'sheet';
}) {
  const app = useSnowdrop();
  const pluginItems = useObservableList(app.registries.menus.member);
  const plugin = conversationId
    ? pluginMenuEntries(pluginItems, { contact, conversationId }, app.registries).flatMap((e) =>
        e.kind === 'item' ? [e] : [],
      )
    : [];
  const { stores } = app;
  const note = useStore(stores.local, localSelectors.note(contact.id));
  const isAdmin = useStore(stores.conversations, (s) =>
    conversationId ? (s.byId[conversationId]?.adminIds.includes(contact.id) ?? false) : false,
  );
  const blockTarget = useBlockTarget(directConversationId(contact.id));
  const blocked = blockTarget?.blocked === true;
  const noteId = useId();
  const showProfileName = contact.profileName && contact.profileName !== contact.name;

  return (
    <div
      className={styles.card}
      data-variant={variant}
      style={{ '--tint': contact.color } as CSSProperties}
    >
      <header className={styles.header}>
        <PersonAvatar
          contactId={contact.id}
          conversationId={conversationId}
          fallback={initialsFor(contact.name)}
          color={contact.color}
          size={48}
          revealable
        />
        <div className={styles.names}>
          <p className={styles.name}>
            {contact.name}
            {!contact.isSelf && <VerifiedBadge contactId={contact.id} />}
          </p>
          {showProfileName && <p className={styles.profileName}>{contact.profileName}</p>}
          {isAdmin && <span className={styles.role}>Group admin</span>}
          {blocked && <span className={styles.role}>Blocked</span>}
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
            {canViewSafetyNumber(app, contact) && (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                icon={<ShieldCheck size={14} />}
                onClick={() => {
                  openSafetyNumber(app, contact.id);
                  onClose();
                }}
              >
                View safety number
              </Button>
            )}
            {canBlock(app) && blockTarget && (
              <Button
                variant="ghost"
                size="sm"
                fullWidth
                icon={blocked ? <CircleSlash size={14} /> : <Ban size={14} />}
                className={blocked ? undefined : styles.dangerAction}
                onClick={() => {
                  openBlockDialog(app, directConversationId(contact.id), blocked);
                  onClose();
                }}
              >
                {blocked ? 'Unblock' : 'Block'}
              </Button>
            )}
          </div>
        )}
        {plugin.length > 0 && (
          <div className={styles.pluginActions} role="group" aria-label="More actions">
            {plugin.map((item) => (
              <Button
                key={item.id}
                variant="ghost"
                size="sm"
                icon={item.icon}
                className={item.danger ? styles.dangerAction : undefined}
                onClick={() => {
                  item.onSelect();
                  onClose();
                }}
              >
                {item.label}
              </Button>
            ))}
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
