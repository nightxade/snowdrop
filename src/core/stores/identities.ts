import { createStore, type StoreApi } from 'zustand/vanilla';
import type { IdentityTrust } from '@/core/backend';

/**
 * How far each person's current key is trusted, as last read from the backend
 * (`null`: asked, and there is no key yet). Session-only: never persisted, and
 * holds no safety numbers or keys, only the trust level, so the verified badge
 * and the review dialog can follow a change without asking again.
 */
export interface IdentitiesState {
  trustById: Record<string, IdentityTrust | null>;
  setTrust(contactId: string, trust: IdentityTrust | null): void;
}

export type IdentitiesStore = StoreApi<IdentitiesState>;

export function createIdentitiesStore(): IdentitiesStore {
  return createStore<IdentitiesState>()((set, get) => ({
    trustById: {},
    setTrust: (contactId, trust) => {
      if (contactId in get().trustById && get().trustById[contactId] === trust) return;
      set((s) => ({ trustById: { ...s.trustById, [contactId]: trust } }));
    },
  }));
}

export const identitiesSelectors = {
  trust: (contactId: string) => (s: IdentitiesState) => s.trustById[contactId],
  verified: (contactId: string) => (s: IdentitiesState) => s.trustById[contactId] === 'verified',
};
