import { useStore } from 'zustand';
import { formatMessageTimestamp, type Message } from '@/core/domain';
import { contactsSelectors, sessionSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { useMinuteClock } from '../lib/useMinuteClock';

export interface ItemMeta {
  author: string;
  /** "Today at 14:02", "Yesterday at 14:02" or a date and time. */
  when: string;
}

/** Who sent a gallery item and when, in the words every tab uses. */
export function useItemMeta(): (message: Message) => ItemMeta {
  const stores = useStores();
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const now = useMinuteClock();
  return (m) => ({
    author: m.authorId === selfId ? 'You' : (contacts[m.authorId]?.name ?? UNKNOWN_CONTACT_NAME),
    when: formatMessageTimestamp(m.receivedAt, now, { clock24h }),
  });
}
