import { createStore, type StoreApi } from 'zustand/vanilla';
import type { Contact } from '@/core/domain';

export interface ContactsState {
  byId: Record<string, Contact>;
  upsertMany(contacts: readonly Contact[]): void;
  upsert(contact: Contact): void;
}

export type ContactsStore = StoreApi<ContactsState>;

export function createContactsStore(): ContactsStore {
  return createStore<ContactsState>()((set) => ({
    byId: {},
    upsertMany: (contacts) => {
      if (contacts.length === 0) return;
      set((s) => {
        const byId = { ...s.byId };
        for (const c of contacts) byId[c.id] = c;
        return { byId };
      });
    },
    upsert: (contact) => {
      set((s) => ({ byId: { ...s.byId, [contact.id]: contact } }));
    },
  }));
}

export const UNKNOWN_CONTACT_NAME = 'Unknown contact';

export const contactsSelectors = {
  byId: (s: ContactsState) => s.byId,
  contact: (id: string) => (s: ContactsState) => s.byId[id],
  /** Display name with a stable fallback so UI never renders an empty label. */
  displayName: (id: string) => (s: ContactsState) => s.byId[id]?.name ?? UNKNOWN_CONTACT_NAME,
};
