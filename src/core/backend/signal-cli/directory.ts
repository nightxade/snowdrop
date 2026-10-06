/**
 * Cached contacts and groups for one account.
 *
 * `listContacts` can be slow — signal-cli refreshes stale profiles from the
 * Signal servers while answering — so it never blocks connecting: it runs in
 * the background with a long timeout, concurrent callers share one request,
 * and a failure leaves the previous (possibly empty) cache in place. Results
 * are reused for a long TTL and refreshed on the events that make them stale
 * (contacts sync, a message from someone unknown, a group we don't know).
 */
import type { Contact, Conversation, ConversationId } from '@/core/domain';
import type { Cancel, Scheduler } from '@/core/lib';
import type { SelfIdentity } from './identity';
import { toContact, toGroupConversation } from './normalise/directory';
import type { DirectPeers } from './peers';
import type { JsonRpcClient } from './rpc';
import { wireContacts, wireGroups, type WireGroup } from './wire';

/** Cached directory data is reused this long before a call re-lists it. */
export const DIRECTORY_TTL_MS = 10 * 60_000;
/** listContacts may fetch profiles from Signal's servers. */
const CONTACTS_TIMEOUT_MS = 180_000;
/** Coalesces refreshes triggered by bursts of messages from unknown senders. */
const REFRESH_DEBOUNCE_MS = 10_000;

export interface DirectoryDeps {
  rpc: JsonRpcClient;
  now: () => number;
  scheduler: Scheduler;
  identity: () => SelfIdentity;
  /** Learns number↔ACI peer aliases and resolves a peer to its canonical id. */
  peers: () => DirectPeers | null;
  /** A contact appeared or changed after a (re)load. */
  onContactChanged: (contact: Contact) => void;
  debug: (message: string, detail?: unknown) => void;
}

export class Directory {
  private readonly contacts = new Map<string, Contact>();
  private readonly dmTimers = new Map<string, number>();
  private readonly groups = new Map<ConversationId, Conversation>();
  private contactsLoadedAt = -Infinity;
  private groupsLoadedAt = -Infinity;
  private contactsLoading: Promise<void> | null = null;
  private groupsLoading: Promise<void> | null = null;
  private refreshTimer: Cancel | null = null;
  /** Bumped by reset(): late results from a previous account are discarded. */
  private epoch = 0;

  constructor(private readonly deps: DirectoryDeps) {}

  reset(): void {
    this.epoch++;
    this.contacts.clear();
    this.dmTimers.clear();
    this.groups.clear();
    this.contactsLoadedAt = -Infinity;
    this.groupsLoadedAt = -Infinity;
    this.contactsLoading = null;
    this.groupsLoading = null;
    this.refreshTimer?.();
    this.refreshTimer = null;
  }

  contact(id: string): Contact | undefined {
    return this.contacts.get(id);
  }

  hasContact(id: string): boolean {
    return this.contacts.has(id);
  }

  allContacts(): Contact[] {
    return [...this.contacts.values()];
  }

  dmTimer(id: string): number {
    return this.dmTimers.get(id) ?? 0;
  }

  setDmTimer(id: string, seconds: number): void {
    this.dmTimers.set(id, seconds);
  }

  group(id: ConversationId): Conversation | undefined {
    return this.groups.get(id);
  }

  allGroups(): Conversation[] {
    return [...this.groups.values()];
  }

  setGroup(conv: Conversation): void {
    this.groups.set(conv.id, conv);
  }

  /** Next listGroups call re-lists (e.g. a message arrived for an unknown group). */
  invalidateGroups(): void {
    this.groupsLoadedAt = -Infinity;
  }

  /** Re-lists contacts soon (debounced), e.g. after a message from a stranger. */
  scheduleContactsRefresh(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = this.deps.scheduler.setTimeout(() => {
      this.refreshTimer = null;
      void this.loadContacts(true);
    }, REFRESH_DEBOUNCE_MS);
  }

  /**
   * Loads (or reuses) contacts. Never rejects: on failure the cache stays as
   * it was and the next call tries again.
   */
  async loadContacts(force = false): Promise<Contact[]> {
    const fresh = this.deps.now() - this.contactsLoadedAt <= DIRECTORY_TTL_MS;
    if (force || !fresh) {
      this.contactsLoading ??= this.fetchContacts().finally(() => {
        this.contactsLoading = null;
      });
      await this.contactsLoading;
    }
    return this.allContacts();
  }

  async loadGroups(force = false): Promise<Conversation[]> {
    const fresh = this.deps.now() - this.groupsLoadedAt <= DIRECTORY_TTL_MS;
    if (force || !fresh) {
      this.groupsLoading ??= this.fetchGroups().finally(() => {
        this.groupsLoading = null;
      });
      await this.groupsLoading;
    }
    return this.allGroups();
  }

  /**
   * Self-aliases first, then fold a peer to whichever form DirectPeers has
   * history under — the same precedence as the normaliser, so group member
   * and admin ids match message authors and the contacts store.
   */
  private resolveMember(groups: readonly WireGroup[]): (id: string) => string {
    const identity = this.deps.identity();
    const peers = this.deps.peers();
    // Members carry both identifiers: learn the pairs first, since groups can
    // load before the contact listing that would otherwise teach them.
    for (const g of groups) {
      for (const m of [...g.members, ...g.admins]) {
        identity.learnPair(m.uuid ?? undefined, m.number ?? undefined);
        peers?.learnPair(m.uuid ?? undefined, m.number ?? undefined);
      }
    }
    return (id) => {
      const self = identity.resolve(id);
      return self === id ? (peers?.resolve(id) ?? id) : self;
    };
  }

  /** Lists one group now (after a group update). */
  async fetchGroup(groupId: string): Promise<Conversation | null> {
    const [raw] = await this.deps.rpc.call('listGroups', { groupId: [groupId] }, wireGroups);
    if (!raw?.isMember) return null;
    const conv = toGroupConversation(raw, this.resolveMember([raw]), 0);
    this.groups.set(conv.id, conv);
    return conv;
  }

  private async fetchContacts(): Promise<void> {
    const epoch = this.epoch;
    let raw;
    try {
      // allRecipients: group members we've never messaged still get names.
      raw = await this.deps.rpc.call('listContacts', { allRecipients: true }, wireContacts, {
        timeoutMs: CONTACTS_TIMEOUT_MS,
      });
    } catch (error) {
      this.deps.debug('listContacts failed; keeping cached contacts', error);
      return;
    }
    if (epoch !== this.epoch) return;
    const identity = this.deps.identity();
    const peers = this.deps.peers();
    const next = new Map<string, Contact>();
    this.dmTimers.clear();
    for (const c of raw) {
      identity.learnPair(c.uuid, c.number);
      peers?.learnPair(c.uuid, c.number);
      const contact = toContact(c, identity.selfId);
      if (!contact) continue;
      // Self-aliases first (isSelf), then fold to whichever form DirectPeers
      // already has history under — same precedence as the normaliser.
      const selfResolved = identity.resolve(contact.id);
      const id =
        selfResolved === contact.id ? (peers?.resolve(contact.id) ?? contact.id) : selfResolved;
      next.set(
        id,
        id === contact.id ? contact : { ...contact, id, isSelf: selfResolved !== contact.id },
      );
      if (c.messageExpirationTime > 0) this.dmTimers.set(id, c.messageExpirationTime);
    }
    const before = new Map(this.contacts);
    this.contacts.clear();
    for (const [id, contact] of next) this.contacts.set(id, contact);
    this.contactsLoadedAt = this.deps.now();
    for (const contact of next.values()) {
      const prev = before.get(contact.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(contact)) {
        this.deps.onContactChanged(contact);
      }
    }
  }

  private async fetchGroups(): Promise<void> {
    const epoch = this.epoch;
    const raw = await this.deps.rpc.call('listGroups', undefined, wireGroups);
    if (epoch !== this.epoch) return;
    const resolve = this.resolveMember(raw);
    this.groups.clear();
    for (const g of raw) {
      if (!g.isMember) continue;
      const conv = toGroupConversation(g, resolve, 0);
      this.groups.set(conv.id, conv);
    }
    this.groupsLoadedAt = this.deps.now();
  }
}
