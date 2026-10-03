import { useEffect, useState } from 'react';
import { bodyToPlainText, type ConversationId, type Message } from '@/core/domain';
import { UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import styles from './LiveAnnouncer.module.css';

const THROTTLE_MS = 1500;
const MAX_TEXT = 140;

/**
 * Screen-reader announcements for genuinely new messages ("Name: text").
 * The virtualised log itself is not a live region: rows mounting while you
 * scroll history would otherwise be read out as if they had just arrived.
 * Bursts are batched so a busy group doesn't flood the speech queue.
 */
export function LiveAnnouncer({ conversationId }: { conversationId: ConversationId }) {
  const { sync, stores } = useSnowdrop();
  const [text, setText] = useState('');

  useEffect(() => {
    let queue: Message[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = () => {
      timer = undefined;
      const batch = queue;
      queue = [];
      if (batch.length === 0) return;
      const contacts = stores.contacts.getState().byId;
      const nameFor = (id: string) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME;
      if (batch.length > 3) {
        const names = [...new Set(batch.map((m) => nameFor(m.authorId)))];
        setText(
          `${batch.length} new messages from ${names.slice(0, 3).join(', ')}${names.length > 3 ? ' and others' : ''}`,
        );
        return;
      }
      setText(
        batch
          .map((m) => {
            const body = bodyToPlainText(m.body, m.ranges, nameFor).trim();
            const said =
              body === ''
                ? `sent ${m.attachments.length > 0 ? 'an attachment' : 'a message'}`
                : body;
            return `${nameFor(m.authorId)}: ${said.length > MAX_TEXT ? `${said.slice(0, MAX_TEXT)}…` : said}`;
          })
          .join('. '),
      );
    };
    const off = sync.on('message', (m) => {
      const selfId = stores.session.getState().self?.id;
      if (m.conversationId !== conversationId || m.authorId === selfId || m.kind !== 'normal')
        return;
      queue.push(m);
      timer ??= setTimeout(flush, THROTTLE_MS);
    });
    return () => {
      off();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [sync, stores, conversationId]);

  return (
    <div className={styles.hidden} role="status" aria-live="polite" aria-atomic="true">
      {text}
    </div>
  );
}
