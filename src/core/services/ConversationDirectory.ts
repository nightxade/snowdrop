/**
 * Which conversations are listed: admission (chats the user deleted stay out),
 * the one-time grandfathering of known chats when message requests arrived,
 * the stale-peer heuristics, the background check for chats the user started
 * from their phone, and the coalesced re-listing of conversations.
 *
 * SyncService owns the queue and the initial sync and calls in at the same
 * points it always did; this holds the rules and their state.
 */
import type { ChatBackend } from '@/core/backend';
import {
  colorForId,
  directConversationId,
  parseConversationId,
  type Conversation,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { createLogger, type Clock } from '@/core/lib';
import { latestRealMessage, type MessageRepository } from '@/core/persistence';
import { selectMessageRequestState, type Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

const log = createLogger('sync');

export interface ConversationDirectoryDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  onError?: ErrorReporter;
}

/** What the directory needs from the sync engine it is attached to. */
export interface ConversationDirectoryHost {
  /** Bumped when the engine stops; background work from an older generation gives up. */
  generation(): number;
}

export class ConversationDirectory {
  private readonly onError: ErrorReporter;
  private host: ConversationDirectoryHost | null = null;
  /**
   * Direct conversations already confirmed (this instance's lifetime) to
   * have a real message in the repository — skips re-checking them on every
   * `dropStaleDirects` call. A real message is never retroactively un-real,
   * so nothing ever needs to leave this set.
   */
  private readonly confirmedReal = new Set<ConversationId>();
  /** `dropStaleDirects` logs its one-time count the same way the backend's own listing does. */
  private staleDropLogged = false;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  /** Conversations whose archive was already asked about the user's own messages (answered, either way). */
  private readonly outgoingChecked = new Set<ConversationId>();
  private outgoingChecking = false;
  private outgoingAgain = false;

  constructor(private readonly deps: ConversationDirectoryDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Called once by the engine that drives this directory. */
  attach(host: ConversationDirectoryHost): void {
    this.host = host;
  }

  private generation(): number {
    return this.host?.generation() ?? 0;
  }

  /**
   * Drops conversations the user deleted (message requests): the backend can
   * keep naming them (a peer list, the phone's history archive) long after.
   * A message from the other side lifts the delete again (`onMessage`).
   */
  admit(conversations: readonly Conversation[]): Conversation[] {
    const local = this.deps.stores.local.getState();
    return conversations.filter((c) => local.deletedChats[c.id] === undefined);
  }

  /**
   * Message requests arrived with this version: every chat this device
   * already knew (it has a read position stored) stays accepted, once, so an
   * upgrade never turns existing conversations into requests. A fresh
   * install knows none, so everything is judged on its own from then on.
   */
  grandfatherRequests(
    conversations: readonly Conversation[],
    known: ReadonlyMap<ConversationId, number>,
  ): void {
    const local = this.deps.stores.local.getState();
    if (local.requestsSeeded) return;
    local.grandfather(
      conversations.filter((c) => known.has(c.id)).map((c) => c.id),
      this.deps.clock.now(),
    );
  }

  /** A real (non-system) message is now stored for this conversation. */
  noteReal(id: ConversationId): void {
    this.confirmedReal.add(id);
  }

  /**
   * The initial sync's stale-peer pass, once seeding has pulled in whatever
   * history there is: a direct conversation only reachable through peer
   * metadata (never a group, which the phone lists by membership alone) that
   * still has no real message anywhere — a peer persisted by the since-fixed
   * bug that let a system line list and bump a DM. Removed from the store and
   * returned. Done here, not by excluding it from the list up front, because
   * the seeding's `bumpActivity` needs the store entry to exist to compare
   * against.
   */
  settleSeeded(
    seeded: readonly { conv: Conversation; hasRealMessage: boolean }[],
  ): ConversationId[] {
    const stale = seeded
      .filter(({ conv, hasRealMessage }) => !hasRealMessage && this.mayDropAsStale(conv))
      .map(({ conv }) => conv.id);
    for (const { conv, hasRealMessage } of seeded) {
      if (hasRealMessage) this.confirmedReal.add(conv.id);
    }
    if (stale.length > 0) this.deps.stores.conversations.getState().removeMany(stale);
    if (!this.staleDropLogged) {
      // Counts only (never names or ids), same discipline as the backend's
      // own "conversations listed" log.
      this.staleDropLogged = true;
      log.info('conversations listed', { staleDirectsDropped: stale.length });
    }
    return stale;
  }

  /**
   * Protocol fields only; local state lives in localStore and is untouched.
   * A direct conversation neither already listed nor yet confirmed to have
   * a real message (`confirmedReal` — set once seeding or `dropStaleDirects`
   * has actually checked the repository) is never created from this alone: a
   * stale persisted peer's own profile/timer refresh (`onContactChanged`,
   * `applyTimer`) must not resurrect it between one `dropStaleDirects` pass
   * and the next. A genuinely new DM is still listed immediately, through the
   * real message that justifies it (`ensureConversation`, called from
   * `onMessage`), which refreshes the full list right after anyway.
   */
  upsertConversation(conv: Conversation): void {
    const { stores } = this.deps;
    if (stores.local.getState().deletedChats[conv.id] !== undefined) return;
    if (
      parseConversationId(conv.id)?.kind === 'direct' &&
      !stores.conversations.getState().byId[conv.id] &&
      !this.confirmedReal.has(conv.id)
    ) {
      return;
    }
    stores.conversations.getState().upsert(conv);
  }

  /**
   * A *real* message for a conversation we don't know yet (someone new
   * messaged us, or we were added to a group) — never called for a system
   * line (see `onMessage`), so a decrypt failure or a timer change for a
   * stranger can never list their DM on its own. DMs can be synthesised
   * immediately so the message is visible; groups need the backend's
   * metadata.
   */
  ensureConversation(message: Message): void {
    const parsed = parseConversationId(message.conversationId);
    const selfId = this.deps.stores.session.getState().self?.id;
    if (parsed?.kind === 'direct' && selfId) {
      const peer = parsed.target;
      const contact = this.deps.stores.contacts.getState().byId[peer];
      if (!contact) {
        this.deps.stores.contacts
          .getState()
          .upsert({ id: peer, name: peer, color: colorForId(peer) });
      }
      this.deps.stores.conversations.getState().upsert({
        id: directConversationId(peer),
        kind: 'direct',
        title: contact?.name ?? peer,
        memberIds: [selfId, peer],
        adminIds: [],
        expireTimerSec: 0,
        lastActivityAt: message.sentAt,
      });
    }
    void this.refreshConversations();
  }

  /** Consumes a refresh requested while one was in flight. */
  private takeRefreshRequest(): boolean {
    const requested = this.refreshAgain;
    this.refreshAgain = false;
    return requested;
  }

  /** Re-lists conversations. Concurrent requests coalesce into one follow-up, never get dropped. */
  refreshConversations(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      this.refreshAgain = false;
      do {
        try {
          const conversations = this.admit(await this.deps.backend.listConversations());
          this.deps.stores.conversations.getState().upsertMany(conversations);
          // The backend can't tell a stale persisted peer from a real one
          // (see SignalCliBackend.listConversations's doc); re-apply the
          // same drop every refresh, or a stale entry excluded at initial
          // sync would reappear the moment anything else re-lists.
          const stale = await this.dropStaleDirects(conversations);
          if (stale.length > 0) this.deps.stores.conversations.getState().removeMany(stale);
          this.checkHistoryOutgoing();
        } catch (error) {
          this.onError(error, 'conversation refresh failed');
        }
      } while (this.takeRefreshRequest());
      this.refreshing = null;
    })();
    return this.refreshing;
  }

  /**
   * A direct conversation that could be a stale peer: not one whose real
   * messages are still only in the backend's history archive (none stored
   * locally yet), and not one open in any space — opening a contact's DM
   * creates an empty placeholder (openDirectConversation) that must not
   * vanish under the user before they've written anything.
   */
  private mayDropAsStale(conv: Conversation): boolean {
    if (
      parseConversationId(conv.id)?.kind !== 'direct' ||
      conv.historyHasMessages ||
      conv.historyUnreadable
    )
      return false;
    const open = this.deps.stores.ui.getState().selectedConversationBySpace;
    return !Object.values(open).includes(conv.id);
  }

  /**
   * Ids of direct conversations with no real (non-system) message anywhere
   * in local storage — a peer persisted by the since-fixed bug that let a
   * system line (a decrypt failure, a timer change) list and bump a DM.
   * Never a group, which the phone lists by membership alone regardless of
   * messages. Safe to call any time after initial sync: by then, every
   * pre-existing conversation's history (if any) has already been pulled
   * in, and a conversation new to *this* call is only ever reached through
   * `ensureConversation`, for a message already stored by the time it is.
   */
  private async dropStaleDirects(
    conversations: readonly Conversation[],
  ): Promise<ConversationId[]> {
    const { repository } = this.deps;
    const candidates = conversations.filter(
      (c) => this.mayDropAsStale(c) && !this.confirmedReal.has(c.id),
    );
    const checked = await Promise.all(
      candidates.map(async (c) => {
        const real = (await latestRealMessage(repository, c.id)) !== undefined;
        if (real) this.confirmedReal.add(c.id);
        return real ? null : c.id;
      }),
    );
    return checked.filter((id): id is ConversationId => id !== null);
  }

  /** A refresh asked while a check ran (a method, so the loop re-reads what the awaits may have changed). */
  private wantsOutgoingCheckAgain(): boolean {
    return this.outgoingAgain;
  }

  /**
   * A chat the user started from their phone counts as accepted (Desktop:
   * any outgoing message), but only the phone's history archive knows that
   * for a chat with nothing stored here yet. Asking costs real lookups, so
   * it happens in the background, after listing, one conversation at a time,
   * and only for chats that are currently message requests and have archived
   * history (normally a handful). Until it answers the chat reads as a
   * request; the answer only ever accepts. A failed ask is retried on the
   * next refresh.
   */
  checkHistoryOutgoing(): void {
    const { backend, stores } = this.deps;
    if (!backend.capabilities.features.has('historyArchive')) return;
    if (this.outgoingChecking) {
      this.outgoingAgain = true;
      return;
    }
    this.outgoingChecking = true;
    const generation = this.generation();
    void (async () => {
      try {
        do {
          this.outgoingAgain = false;
          for (const c of Object.values(stores.conversations.getState().byId)) {
            if (generation !== this.generation()) return;
            if (!c.historyHasMessages || this.outgoingChecked.has(c.id)) continue;
            if (selectMessageRequestState(stores, c.id) !== 'request') continue;
            try {
              const wrote = await backend.historyHasOutgoing(c.id);
              this.outgoingChecked.add(c.id);
              if (wrote && generation === this.generation())
                stores.local.getState().markAccepted(c.id, this.deps.clock.now());
            } catch (error) {
              this.onError(error, 'history outgoing check failed');
            }
          }
        } while (this.wantsOutgoingCheckAgain() && generation === this.generation());
      } finally {
        this.outgoingChecking = false;
      }
    })();
  }
}
