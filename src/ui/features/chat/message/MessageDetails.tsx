import { useMemo } from 'react';
import { useStore } from 'zustand';
import { formatMessageTimestamp, initialsFor, type Message } from '@/core/domain';
import { conversationsSelectors, contactsSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useEffectivePrivacy, useSnowdrop } from '@/ui/hooks';
import { PersonAvatar } from '@/ui/features/conversation';
import { Modal } from '@/ui/primitives';
import { useMinuteClock } from '../lib/useMinuteClock';
import styles from './MessageDetails.module.css';

interface DetailRow {
  id: string;
  name: string;
  color: string;
  /** "Today at 14:02" (or the send time, for "Sent to") — same format the row's own meta uses. */
  when: string;
}

interface DetailGroup {
  title: string;
  rows: DetailRow[];
}

/**
 * "Message details": who's read, who's only received, and who's still just
 * been sent this message of yours — the per-recipient breakdown behind the
 * single row-level status mark (see `MessageMeta`). For a DM this is one row
 * under whichever heading applies; for a group it's the same four buckets
 * Signal Desktop uses, in the same order.
 */
export function MessageDetails({
  message: m,
  onOpenChange,
}: {
  message: Message;
  onOpenChange: (open: boolean) => void;
}) {
  const { stores } = useSnowdrop();
  const byId = useStore(stores.contacts, contactsSelectors.byId);
  const conversation = useStore(
    stores.conversations,
    conversationsSelectors.conversation(m.conversationId),
  );
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const now = useMinuteClock();
  // With read receipts off Signal shows no one's read marks: they count as delivered.
  const showRead = useEffectivePrivacy().showReadReceipts;

  const groups = useMemo((): DetailGroup[] => {
    const when = (at: number) => formatMessageTimestamp(at, now, { clock24h });
    const recipients = (conversation?.memberIds ?? []).filter((id) => id !== m.authorId);
    const failed = new Set(m.failedRecipients ?? []);
    const buckets: Record<'read' | 'delivered' | 'sent' | 'notDelivered', DetailRow[]> = {
      read: [],
      delivered: [],
      sent: [],
      notDelivered: [],
    };
    for (const id of recipients) {
      const contact = byId[id];
      const row: DetailRow = {
        id,
        name: contact?.name ?? UNKNOWN_CONTACT_NAME,
        color: contact?.color ?? 'var(--snowdrop-avatar-1)',
        when: '',
      };
      if (failed.has(id)) {
        buckets.notDelivered.push({ ...row, when: "Couldn't deliver" });
        continue;
      }
      const receipt = m.receipts?.[id];
      if (receipt?.status === 'read' && showRead) {
        buckets.read.push({ ...row, when: when(receipt.at) });
      } else if (receipt?.status === 'delivered' || receipt?.status === 'read') {
        buckets.delivered.push({ ...row, when: when(receipt.at) });
      } else {
        buckets.sent.push({ ...row, when: when(m.sentAt) });
      }
    }
    return [
      { title: 'Read by', rows: buckets.read },
      { title: 'Delivered to', rows: buckets.delivered },
      { title: 'Sent to', rows: buckets.sent },
      { title: 'Not delivered', rows: buckets.notDelivered },
    ].filter((g) => g.rows.length > 0);
  }, [
    conversation,
    byId,
    m.authorId,
    m.failedRecipients,
    m.receipts,
    m.sentAt,
    clock24h,
    now,
    showRead,
  ]);

  return (
    <Modal open onOpenChange={onOpenChange} title="Message details" size="sm">
      {groups.length === 0 ? (
        <p className={styles.empty}>Nobody to show yet.</p>
      ) : (
        groups.map((group) => (
          <section key={group.title} className={styles.group}>
            <h3 className={styles.heading}>{group.title}</h3>
            <ul className={styles.list}>
              {group.rows.map((row) => (
                <li key={row.id} className={styles.row}>
                  <PersonAvatar
                    contactId={row.id}
                    conversationId={m.conversationId}
                    fallback={initialsFor(row.name)}
                    color={row.color}
                    size={32}
                  />
                  <span className={styles.name}>{row.name}</span>
                  <span className={styles.when}>{row.when}</span>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </Modal>
  );
}
