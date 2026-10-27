import { Ban } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { directConversationId, initialsFor, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import {
  BlockDialog,
  ConversationAvatarById,
  formatPhone,
  PersonAvatar,
} from '@/ui/features/conversation';
import { useStores } from '@/ui/hooks';
import { Button, EmptyState } from '@/ui/primitives';
import styles from './BlockedList.module.css';

interface Entry {
  id: ConversationId;
  name: string;
  detail: string;
  /** Present for a person: whose picture to show. */
  contactId?: string;
  color?: string;
}

/**
 * The people and groups the user blocked, each with Unblock (which asks
 * first, as Signal Desktop does). A person comes from the contact list, so
 * someone blocked who was never written to is here too; a group is a chat
 * the user blocked (and left), whose history is still on this device.
 */
export function BlockedList() {
  const { contacts, conversations } = useStores();
  const contactsById = useStore(contacts, (s) => s.byId);
  const byId = useStore(conversations, (s) => s.byId);
  const [confirming, setConfirming] = useState<ConversationId | null>(null);

  const { people, groups } = useMemo(() => {
    const people: Entry[] = Object.values(contactsById)
      .filter((c) => c.blocked === true && c.isSelf !== true)
      .map((c) => ({
        id: directConversationId(c.id),
        name: stripBidiControls(c.name),
        detail: c.number ? formatPhone(c.number) : '',
        contactId: c.id,
        color: c.color,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const groups: Entry[] = Object.values(byId)
      .filter((c) => c.kind === 'group' && c.blocked === true)
      .map((c) => ({
        id: c.id,
        name: stripBidiControls(c.title),
        detail: `Group, ${c.memberIds.length} member${c.memberIds.length === 1 ? '' : 's'}`,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { people, groups };
  }, [contactsById, byId]);

  const section = (label: string, entries: Entry[]) =>
    entries.length === 0 ? null : (
      <div className={styles.group}>
        <p className={styles.groupLabel} id={`blocked-${label}`}>
          {label}
        </p>
        <ul className={styles.list} aria-labelledby={`blocked-${label}`}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.item}>
              {entry.contactId ? (
                <PersonAvatar
                  contactId={entry.contactId}
                  conversationId={entry.id}
                  fallback={initialsFor(entry.name)}
                  color={entry.color ?? 'var(--snowdrop-avatar-1)'}
                  size={32}
                />
              ) : (
                <ConversationAvatarById id={entry.id} size={32} />
              )}
              <span className={styles.text}>
                <span className={styles.name}>
                  <bdi>{entry.name}</bdi>
                </span>
                {entry.detail && <span className={styles.detail}>{entry.detail}</span>}
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Unblock ${entry.name}`}
                onClick={() => {
                  setConfirming(entry.id);
                }}
              >
                Unblock
              </Button>
            </li>
          ))}
        </ul>
      </div>
    );

  return (
    <>
      {people.length === 0 && groups.length === 0 ? (
        <EmptyState size="sm" icon={<Ban />} title="No one is blocked">
          Block someone from their profile or a chat menu. They can’t call you or send you messages.
        </EmptyState>
      ) : (
        <>
          {section('People', people)}
          {section('Groups', groups)}
        </>
      )}
      {confirming && (
        <BlockDialog
          conversationId={confirming}
          unblock
          onClose={() => {
            setConfirming(null);
          }}
        />
      )}
    </>
  );
}
