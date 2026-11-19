import { Ban } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { directConversationId, initialsFor, type ConversationId } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import {
  BlockDialog,
  ConversationAvatarById,
  formatPhone,
  PersonAvatar,
} from '@/ui/features/conversation';
import { neighbourOf, useStores } from '@/ui/hooks';
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
  /** The entries as they were when Unblock was chosen: where its neighbours were. */
  const asked = useRef<{ id: ConversationId; order: ConversationId[] } | null>(null);

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

  // Unblocking takes the entry (and its button, which had focus) away: focus goes to the next
  // entry's button, else the previous, else the empty state, so it stays in Settings (M15).
  const focusAfterUnblock = () => {
    const was = asked.current;
    if (!was) return null;
    const now = [...document.querySelectorAll('[data-blocked-id]')].map((e) =>
      e.getAttribute('data-blocked-id'),
    );
    if (now.includes(was.id)) return null;
    const next = neighbourOf<string | null>(was.order, now, was.id);
    return (
      (next
        ? document.querySelector<HTMLElement>(`[data-blocked-id="${CSS.escape(next)}"] button`)
        : null) ?? document.querySelector<HTMLElement>('[data-blocked-empty]')
    );
  };

  const section = (label: string, entries: Entry[]) =>
    entries.length === 0 ? null : (
      <div className={styles.group}>
        <p className={styles.groupLabel} id={`blocked-${label}`}>
          {label}
        </p>
        <ul className={styles.list} aria-labelledby={`blocked-${label}`}>
          {entries.map((entry) => (
            <li key={entry.id} className={styles.item} data-blocked-id={entry.id}>
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
                  asked.current = { id: entry.id, order: [...people, ...groups].map((e) => e.id) };
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
        <div tabIndex={-1} data-blocked-empty="" className={styles.empty}>
          <EmptyState size="sm" icon={<Ban />} title="No one is blocked">
            Block someone from their profile or a chat menu. They can’t call you or send you
            messages.
          </EmptyState>
        </div>
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
          returnFocus={focusAfterUnblock}
          onClose={() => {
            setConfirming(null);
          }}
        />
      )}
    </>
  );
}
