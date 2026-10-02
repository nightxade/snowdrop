import type { CSSProperties } from 'react';
import { useStore } from 'zustand';
import { formatMessageTimestamp, initialsFor, type Message } from '@/core/domain';
import { contactsSelectors, sessionSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { Avatar } from '@/ui/primitives';
import { useMinuteClock } from '../lib/useMinuteClock';
import { MessageBody } from '../message/MessageBody';
import styles from './MessageResult.module.css';

/** A message as a clickable result (search, pins, mentions inbox). */
export function MessageResult({
  message: m,
  context,
  onOpen,
}: {
  message: Message;
  /** e.g. the conversation title, shown above the author (mentions inbox). */
  context?: string;
  onOpen: () => void;
}) {
  const stores = useStores();
  const author = useStore(stores.contacts, contactsSelectors.contact(m.authorId));
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const now = useMinuteClock();
  const name = author?.name ?? UNKNOWN_CONTACT_NAME;
  return (
    <button type="button" className={styles.result} onClick={onOpen} data-search-result>
      {context && <span className={styles.context}>{context}</span>}
      <span className={styles.row}>
        <Avatar
          size={32}
          {...(author?.avatarUrl ? { src: author.avatarUrl } : {})}
          fallback={initialsFor(name)}
          color={author?.color ?? 'var(--shrike-avatar-1)'}
        />
        <span className={styles.main}>
          <span className={styles.head}>
            <span
              className={styles.name}
              style={
                { '--name-color': author?.color ?? 'var(--shrike-text-strong)' } as CSSProperties
              }
            >
              {name}
            </span>
            <span className={styles.time}>
              {formatMessageTimestamp(m.sentAt, now, { clock24h })}
            </span>
          </span>
          <MessageBody
            className={styles.body}
            preview
            body={m.body}
            ranges={m.ranges}
            selfId={selfId}
            nameFor={(id) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME}
          />
        </span>
      </span>
    </button>
  );
}
