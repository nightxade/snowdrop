/**
 * The sync engine: backend events → repository + stores.
 *
 * Invariants:
 * - Events are processed strictly in arrival order through one queue, so an
 *   edit can never overtake the message it edits.
 * - The queue is gated on the initial sync: anything the backend delivers
 *   while we're still loading contacts/history (e.g. envelopes queued while
 *   the app was closed) is processed afterwards, against real read cursors,
 *   and therefore shows up as unread.
 * - start()/stop() are idempotent and restartable; a failed start leaves no
 *   subscriptions behind.
 * The UI only ever reads stores; it never subscribes to the backend.
 */
import type {
  BackendEvents,
  ChatBackend,
  MessageRef,
  PhonePrivacyPatch,
  ProfileUpdate,
} from '@/core/backend';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyPollTerminate,
  applyPollVote,
  applyReaction,
  applyRecipientReceipt,
  colorForId,
  directConversationId,
  mergeDuplicate,
  messageId,
  parseConversationId,
  pollEndedText,
  systemMessageId,
  type Contact,
  type Conversation,
  type ConversationId,
  type Message,
  type MessageId,
  type MessageStatus,
} from '@/core/domain';
import {
  createLogger,
  Emitter,
  type Cancel,
  type Clock,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import { latestRealMessage, type MessageRepository } from '@/core/persistence';
import {
  computeUnread,
  effectivePrivacy,
  acceptForOutgoing,
  isDeletedRequest,
  selectMessageRequestState,
  UNKNOWN_PHONE_PRIVACY,
  uiSelectors,
  UNKNOWN_CONTACT_NAME,
  type Stores,
} from '@/core/stores';
import { CatchUpTracker, NOTIFICATION_HOLD_CEILING_MS } from './CatchUpTracker';
import { PendingOpsBuffer } from './PendingOpsBuffer';
import { ReceiptBuffer } from './ReceiptBuffer';
import { consoleReporter, type ErrorReporter } from './types';

export interface SyncServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  scheduler: Scheduler;
  /** Shared with SendService so early receipts reach reconciled sends. */
  receipts?: ReceiptBuffer;
  /** Shared with SendService so ops that beat their target message aren't lost. */
  pendingOps?: PendingOpsBuffer;
  onError?: ErrorReporter;
  /** Newest messages copied from backend history per conversation on first sync. */
  seedPageSize?: number;
  /** How often expired (disappearing) messages are purged. */
  purgeIntervalMs?: number;
}

export interface SyncEvents {
  /** A *new* message (incoming or synced), after it has been stored and applied. */
  message: Message;
  /**
   * The same moment, with how the message arrived: `live` is false for
   * messages parked during the initial sync (delivered while the app was
   * closed) and replayed once it completed. Plugins' `onMessage` uses it.
   */
  messageArrived: { message: Message; live: boolean };
  /**
   * News about a poll, once it has been applied: `vote` is someone else's
   * new answer (with at least one choice) on a poll the user created; `end`
   * is someone else ending their poll. `message` is the poll as it now
   * stands. `live` is false when it was parked behind the initial sync.
   */
  pollActivity: { kind: 'vote' | 'end'; message: Message; actorId: string; live: boolean };
}

const RECEIPT_STATUS: Record<BackendEvents['receipt']['type'], MessageStatus> = {
  delivered: 'delivered',
  read: 'read',
  viewed: 'read',
};

/** How many purged message ids are remembered to suppress re-delivery. */
const PURGED_TOMBSTONES = 2_000;

const log = createLogger('sync');

/**
 * Error kinds that mean "an expected first-run/setup state", not a real
 * failure: the UI routes to its own screen for each of these (link flow,
 * account prompt, install prompt, unlock screen) rather than showing an
 * error. Logged once, at info — not at error, and not from every place that
 * happens to observe the same rejection (see `wasConnectionErrorReported`).
 */
const SETUP_STATE_MESSAGES: Record<string, string> = {
  'not-installed': "signal-cli isn't installed yet (first run)",
  'no-account': 'no linked account yet; showing the link screen',
  'account-required': 'signal-cli needs an account number; showing the setup screen',
  'storage-locked': 'local storage is locked; showing the unlock screen',
};

/**
 * `account-unavailable` means the backend already tried a bounded backoff
 * itself (restarting signal-cli a few times) and still couldn't load a
 * previously-linked account — never routed to the link screen, so this is
 * the steady-state fallback: keep retrying the whole connect on this
 * interval, same as if the user kept pressing the connection banner's Retry.
 */
const ACCOUNT_UNAVAILABLE_RETRY_MS = 60_000;

/**
 * Retry cadence for a failed read of the phone's privacy settings. Until one
 * succeeds nothing that depends on them is sent (see `effectivePrivacy`), so
 * a few quick tries cover a daemon that is still starting up.
 */
const PHONE_PRIVACY_RETRY_MS = 3_000;
const PHONE_PRIVACY_MAX_RETRIES = 8;

/**
 * Tags a connect/initial-sync failure once `doStart` has logged and stored
 * it, so other places that see the very same rejection bubble through
 * (e.g. `createSnowdrop`'s `start()`, re-thrown up to callers in
 * `src/app/App.tsx`) know not to log it again. A `WeakSet` rather than a
 * property on the error itself: nothing about the error's own shape changes.
 */
const reportedConnectionErrors = new WeakSet<object>();

function markConnectionErrorReported(error: unknown): void {
  if (typeof error === 'object' && error !== null) reportedConnectionErrors.add(error);
}

/** True if `error` is a connect/initial-sync failure {@link SyncService} already logged. */
export function wasConnectionErrorReported(error: unknown): boolean {
  return typeof error === 'object' && error !== null && reportedConnectionErrors.has(error);
}

export class SyncService {
  private readonly events = new Emitter<SyncEvents>();
  private readonly receipts: ReceiptBuffer;
  private readonly pendingOps: PendingOpsBuffer;
  private readonly onError: ErrorReporter;
  private unsubscribers: Unsubscribe[] = [];
  private queue: Promise<void> = Promise.resolve();
  private startPromise: Promise<void> | null = null;
  /** Bumped on stop; queued handlers from older generations are dropped. */
  private generation = 0;
  /**
   * While true (until an initial sync succeeds), queued events are parked in
   * `backlog` instead of running. The backlog survives a failed start and is
   * replayed after the next successful one: signal-cli won't redeliver them.
   */
  private gated = true;
  private backlog: { event: string; task: () => Promise<void> | void }[] = [];
  private pruneTimer: Cancel | null = null;
  private purgeTimer: Cancel | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private readonly readingHistory = new Set<MessageId>();
  private readonly catchUpTracker: CatchUpTracker;
  /**
   * A second tracker driven in lockstep with `catchUpTracker`, with the same
   * start, quiet period and `caughtUp`, that only differs in its ceiling: it
   * drives `session.notificationsHeld`, which can outlast the sidebar's
   * `catchingUp` (see `startCatchUp`).
   */
  private readonly notificationHold: CatchUpTracker;
  /** Read receipts earned while the phone's settings were still unknown; sent or dropped once they're known. */
  private heldReceipts: {
    conversationId: ConversationId;
    messages: MessageRef[];
    accepted: boolean;
    syncWithoutReceipt: boolean;
  }[] = [];
  /** Latest phone-privacy read wins; an older answer arriving late is ignored. */
  private privacyReadSeq = 0;
  private privacyRetryCancel: Cancel | null = null;
  private privacyRetries = 0;
  /** A pending steady-state retry after `account-unavailable` (see `doStart`'s catch). */
  private accountRetryCancel: Cancel | null = null;
  /**
   * Direct conversations already confirmed (this instance's lifetime) to
   * have a real message in the repository — skips re-checking them on every
   * `dropStaleDirects` call. A real message is never retroactively un-real,
   * so nothing ever needs to leave this set.
   */
  private readonly confirmedReal = new Set<ConversationId>();
  /** `dropStaleDirects` logs its one-time count the same way the backend's own listing does. */
  private staleDropLogged = false;

  constructor(private readonly deps: SyncServiceDeps) {
    this.receipts = deps.receipts ?? new ReceiptBuffer();
    this.pendingOps = deps.pendingOps ?? new PendingOpsBuffer();
    this.onError = deps.onError ?? consoleReporter;
    this.catchUpTracker = new CatchUpTracker({
      clock: deps.clock,
      scheduler: deps.scheduler,
      onChange: (catchingUp) => {
        this.deps.stores.session.getState().setCatchingUp(catchingUp);
      },
    });
    this.notificationHold = new CatchUpTracker({
      clock: deps.clock,
      scheduler: deps.scheduler,
      onChange: (held) => {
        this.deps.stores.session.getState().setNotificationsHeld(held);
      },
    });
  }

  /** Subscribes, connects and performs the initial sync. Safe to call repeatedly. */
  start(): Promise<void> {
    this.startPromise ??= this.doStart().catch((error: unknown) => {
      this.startPromise = null;
      throw error;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    const { backend, stores } = this.deps;
    // A fresh attempt (manual or the steady-state retry below) supersedes
    // any retry still pending from an earlier failure.
    this.accountRetryCancel?.();
    this.accountRetryCancel = null;
    stores.session.getState().setBackendKind(backend.kind);
    this.gated = true;
    this.subscribe();
    // "Catching up" from here; `subscribe()` wired the events that end it.
    this.startCatchUp();
    // Until the connected daemon has been asked, nothing that depends on the
    // phone's privacy settings (read receipts, typing, link previews) may go
    // out. `refreshPhonePrivacy` settles this right after `connect()`.
    stores.session.getState().setPhonePrivacy({ status: 'pending', values: UNKNOWN_PHONE_PRIVACY });
    try {
      await backend.connect();
      await this.refreshPhonePrivacy();
      await this.initialSync();
    } catch (error) {
      // Drop the subscriptions so a retry doesn't double-subscribe, but keep the
      // backlog: those envelopes are gone from the daemon once delivered.
      this.unsubscribeAll();
      this.disposeCatchUp();
      const kind = errorKindOf(error);
      stores.session
        .getState()
        .setError(error instanceof Error ? error.message : String(error), kind);
      stores.session.getState().setStatus('error');
      // The single place this failure is logged (see `wasConnectionErrorReported`):
      // an expected setup state (no account yet, signal-cli not installed, …)
      // is routed to its own screen and logged once at info, not at error;
      // a real failure still logs once, at error, never from the other
      // places (App.tsx, ConnectionBanner) that also observe this rejection.
      const setupMessage = kind !== null ? SETUP_STATE_MESSAGES[kind] : undefined;
      if (setupMessage !== undefined) log.info(setupMessage);
      else this.onError(error, 'initial sync failed');
      markConnectionErrorReported(error);
      // The backend already backed off restarting signal-cli a few times
      // (see SignalCliBackend's `resolveAccount`); keep that going at a
      // slower, steady pace rather than leaving it to a manual Retry click —
      // this must never happen for `no-account`/`account-required`, which
      // mean the user has to act (link, or enter an account number).
      if (kind === 'account-unavailable') {
        this.accountRetryCancel = this.deps.scheduler.setTimeout(() => {
          this.accountRetryCancel = null;
          this.start().catch(() => undefined);
        }, ACCOUNT_UNAVAILABLE_RETRY_MS);
      }
      throw error;
    }
    stores.session.getState().setReady(true);
    this.openGate();
    this.armCatchUpQuiet();
    this.schedulePurge(0);
  }

  /**
   * Begins "catching up": the sidebar freeze, and the hold on notifications.
   * Both end together on `caughtUp` or the quiet period; they differ only in
   * the ceiling. The sidebar's stays short so the UI never looks stuck. The
   * hold's is much longer when the backend is known to send `caughtUp`
   * (`supportsCatchingUpSignal`), because then the ceiling is only a safety
   * net and a backlog still draining when it fires would all notify; without
   * that signal it is the same short one, so older builds behave as before.
   */
  private startCatchUp(): void {
    this.catchUpTracker.start();
    this.notificationHold.start(
      this.deps.backend.supportsCatchingUpSignal?.() === true
        ? NOTIFICATION_HOLD_CEILING_MS
        : undefined,
    );
  }

  private armCatchUpQuiet(): void {
    this.catchUpTracker.armQuiet();
    this.notificationHold.armQuiet();
  }

  private disposeCatchUp(): void {
    this.catchUpTracker.dispose();
    this.notificationHold.dispose();
  }

  /** Releases events parked during initial sync, in arrival order. */
  private openGate(): void {
    this.gated = false;
    const parked = this.backlog;
    this.backlog = [];
    for (const { event, task } of parked) this.enqueue(event, task);
  }

  private enqueue(event: string, task: () => Promise<void> | void): void {
    const generation = this.generation;
    this.queue = this.queue.then(() =>
      generation === this.generation ? this.run(event, task) : undefined,
    );
  }

  private unsubscribeAll(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  async stop(): Promise<void> {
    if (this.startPromise) await this.startPromise.catch(() => undefined);
    this.accountRetryCancel?.();
    this.accountRetryCancel = null;
    this.privacyRetryCancel?.();
    this.privacyRetryCancel = null;
    this.pruneTimer?.();
    this.purgeTimer?.();
    this.pruneTimer = null;
    this.purgeTimer = null;
    this.disposeCatchUp();
    await this.idle();
    // Disconnect while still subscribed so the final "offline" status reaches the store.
    await this.deps.backend.disconnect();
    this.teardown();
    this.startPromise = null;
    this.deps.stores.session.getState().setReady(false);
  }

  private teardown(): void {
    this.generation++;
    this.unsubscribeAll();
    this.queue = Promise.resolve();
    this.backlog = [];
    this.gated = true;
    this.heldReceipts = [];
    this.privacyReadSeq++;
    this.privacyRetryCancel?.();
    this.privacyRetryCancel = null;
  }

  /** Post-processing hooks (plugins, notifications) that should see stored state. */
  on<E extends keyof SyncEvents>(event: E, fn: (payload: SyncEvents[E]) => void): Unsubscribe {
    return this.events.on(event, fn);
  }

  /** Resolves once every queued event has been processed (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
  }

  private selfId(): string | undefined {
    return this.deps.stores.session.getState().self?.id;
  }

  // ─── Initial sync ──────────────────────────────────────────────────────

  private async initialSync(): Promise<void> {
    const { backend, repository, stores } = this.deps;
    const [self, contacts, listedByBackend] = await Promise.all([
      backend.getSelf(),
      backend.listContacts(),
      backend.listConversations(),
    ]);
    const conversations = this.admit(listedByBackend);
    stores.session.getState().setSelf(self);
    stores.contacts.getState().upsertMany([self, ...contacts]);
    this.grandfatherRequests(conversations, await repository.getReadCursors());
    stores.conversations.getState().upsertMany(conversations);
    this.seedHistoryLocalState(conversations);

    await this.recoverHistoryTimers();
    const cursors = await repository.getReadCursors();
    const seeded = await Promise.all(
      conversations.map(async (conv) => {
        const result = await this.seedConversation(conv, cursors.get(conv.id));
        cursors.set(conv.id, result.cursor);
        return { conv, hasRealMessage: result.hasRealMessage };
      }),
    );
    // A direct conversation only reachable through peer metadata (never a
    // group, which the phone lists by membership alone) that still has no
    // real message anywhere now that seeding above pulled in whatever
    // history it has: a peer persisted by the since-fixed bug that let a
    // system line list and bump a DM. Dropped here, not excluded from
    // `conversations` up front, because bumpActivity above needs the store
    // entry to already exist to compare against (see `seedConversation`).
    const stale = seeded
      .filter(({ conv, hasRealMessage }) => !hasRealMessage && this.mayDropAsStale(conv))
      .map(({ conv }) => conv.id);
    for (const { conv, hasRealMessage } of seeded) {
      if (hasRealMessage) this.confirmedReal.add(conv.id);
    }
    if (stale.length > 0) {
      stores.conversations.getState().removeMany(stale);
      for (const id of stale) cursors.delete(id);
    }
    if (!this.staleDropLogged) {
      // Counts only (never names or ids), same discipline as the backend's
      // own "conversations listed" log.
      this.staleDropLogged = true;
      log.info('conversations listed', { staleDirectsDropped: stale.length });
    }
    const listed = conversations.filter((c) => !stale.includes(c.id));
    while ((await this.purgeExpired()) === 500) {
      // Drain expired cache entries before setting ready or exposing message previews.
    }
    stores.conversations.getState().setReadCursors(Object.fromEntries(cursors));
    await Promise.all(listed.map((c) => this.recomputeUnread(c.id)));
    this.checkHistoryOutgoing();
  }

  /** Conversations whose archive was already asked about the user's own messages (answered, either way). */
  private readonly outgoingChecked = new Set<ConversationId>();
  private outgoingChecking = false;
  private outgoingAgain = false;

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
  /** A refresh asked while a check ran (a method, so the loop re-reads what the awaits may have changed). */
  private wantsOutgoingCheckAgain(): boolean {
    return this.outgoingAgain;
  }

  private checkHistoryOutgoing(): void {
    const { backend, stores } = this.deps;
    const ask = backend.historyHasOutgoing?.bind(backend);
    if (!ask) return;
    if (this.outgoingChecking) {
      this.outgoingAgain = true;
      return;
    }
    this.outgoingChecking = true;
    const generation = this.generation;
    void (async () => {
      try {
        do {
          this.outgoingAgain = false;
          for (const c of Object.values(stores.conversations.getState().byId)) {
            if (generation !== this.generation) return;
            if (!c.historyHasMessages || this.outgoingChecked.has(c.id)) continue;
            if (selectMessageRequestState(stores, c.id) !== 'request') continue;
            try {
              const wrote = await ask(c.id);
              this.outgoingChecked.add(c.id);
              if (wrote && generation === this.generation)
                stores.local.getState().markAccepted(c.id, this.deps.clock.now());
            } catch (error) {
              this.onError(error, 'history outgoing check failed');
            }
          }
        } while (this.wantsOutgoingCheckAgain() && generation === this.generation);
      } finally {
        this.outgoingChecking = false;
      }
    })();
  }

  /**
   * Drops conversations the user deleted (message requests): the backend can
   * keep naming them (a peer list, the phone's history archive) long after.
   * A message from the other side lifts the delete again (`onMessage`).
   */
  private admit(conversations: readonly Conversation[]): Conversation[] {
    const local = this.deps.stores.local.getState();
    return conversations.filter((c) => local.deletedChats[c.id] === undefined);
  }

  /**
   * Message requests arrived with this version: every chat this device
   * already knew (it has a read position stored) stays accepted, once, so an
   * upgrade never turns existing conversations into requests. A fresh
   * install knows none, so everything is judged on its own from then on.
   */
  private grandfatherRequests(
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

  /**
   * One-time seed only: a conversation's `historyArchived` hint
   * (`Conversation.historyArchived`, see core/domain/types.ts) sets
   * localStore's own `archived` flag, but only for a conversation that has
   * no local state at all yet. A conversation the user has already touched
   * in Snowdrop — even to explicitly un-archive it — keeps its own state
   * forever; this never looks at it again past the first time it appears.
   */
  private seedHistoryLocalState(conversations: readonly Conversation[]): void {
    const local = this.deps.stores.local.getState();
    for (const conv of conversations) {
      if (conv.historyArchived && !local.conversations[conv.id]) local.setArchived(conv.id, true);
    }
  }

  /**
   * Makes sure a conversation has local history and a read cursor (a seq),
   * and reports whether it has a real (non-system) message anywhere in
   * local storage now that this has run — used to drop a stale peer-only
   * direct conversation (see `initialSync`).
   */
  private async seedConversation(
    conv: Conversation,
    storedCursor: number | undefined,
  ): Promise<{ cursor: number; hasRealMessage: boolean }> {
    const { backend, repository, stores } = this.deps;
    let cursor = storedCursor;
    if (
      backend.fetchHistory &&
      !isDeletedRequest(stores, conv.id) &&
      (await repository.count(conv.id)) === 0
    ) {
      const page = await backend.fetchHistory(conv.id, { limit: this.deps.seedPageSize ?? 50 });
      // Checked again after the (slow) fetch: the user may have deleted it meanwhile.
      const stored = isDeletedRequest(stores, conv.id)
        ? []
        : await repository.upsertMany(page.messages, {
            backfill: false,
            merge: mergeDuplicate,
          });
      acceptForOutgoing(stores, stored, this.deps.clock.now());
      if (cursor === undefined && page.readUpTo !== undefined) {
        const readUpTo = page.readUpTo;
        // Convert the backend's timestamp-based position into our seq space.
        const read = stored.filter((m) => m.sentAt <= readUpTo);
        cursor = read.at(-1)?.seq ?? (stored[0]?.seq ?? 1) - 1;
      }
    }
    // The sidebar preview shows the absolute newest stored message, system
    // lines included (that's the existing, intentional behaviour); ordering
    // (`bumpActivity`) must never move for one, so it's computed separately
    // — reusing `latest` without another lookup in the common case where
    // it's already real.
    const latest = await repository.latest(conv.id);
    if (latest) stores.conversations.getState().noteLatest(latest);
    const latestReal =
      latest?.kind === 'normal' ? latest : await latestRealMessage(repository, conv.id);
    if (latestReal) stores.conversations.getState().bumpActivity(conv.id, latestReal.sentAt);
    // First sight with no read info: everything stored *before this session* is
    // read. Live events are gated until after this, so they still count.
    cursor ??= latest?.seq ?? 0;
    if (cursor !== storedCursor) await repository.setReadCursor(conv.id, cursor);
    return { cursor, hasRealMessage: latestReal !== undefined };
  }

  /** Recounts from the cursor; only reads unread messages, never the whole history. */
  private async recomputeUnread(conversationId: ConversationId): Promise<void> {
    const { repository, stores } = this.deps;
    const selfId = this.selfId();
    if (!selfId) return;
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const after = await repository.listAfter(conversationId, cursor);
    stores.conversations.getState().setUnread(conversationId, computeUnread(after, selfId, cursor));
  }

  // ─── Read state ────────────────────────────────────────────────────────

  /** Recover a server-committed read whose local write was interrupted. */
  private async recoverHistoryTimers(): Promise<void> {
    const { backend, repository, stores, clock } = this.deps;
    if (!backend.getHistoryReadState) return;
    const generation = this.generation;
    const pending = await repository.pendingHistoryTimers();
    for (let start = 0; start < pending.length; start += 500) {
      if (generation !== this.generation) return;
      const batch = pending.slice(start, start + 500);
      const selected = new Map(batch.map((message) => [message.id, message]));
      const states = await backend.getHistoryReadState(
        batch.flatMap((message) =>
          message.historyCursor ? [{ id: message.id, cursor: message.historyCursor }] : [],
        ),
      );
      if (generation !== this.generation) return;
      if (
        states.length !== selected.size ||
        new Set(states.map((state) => state.id)).size !== states.length
      )
        throw new Error('History recovery omitted or duplicated a message');
      for (const state of states) {
        const message = selected.get(state.id);
        if (!message) throw new Error('History recovery returned an unknown message');
        if (
          state.expiresAt !== undefined &&
          (!Number.isSafeInteger(state.expiresAt) || state.expiresAt <= 0)
        )
          throw new Error('History recovery returned an invalid deadline');
        if (
          state.unavailable ||
          (state.expiresAt !== undefined && state.expiresAt <= clock.now())
        ) {
          await repository.delete(state.id);
          if (generation !== this.generation) return;
          this.rememberPurged(state.id);
          stores.messages.getState().remove(message.conversationId, state.id);
          const selfId = this.selfId();
          if (selfId) stores.conversations.getState().applyRemoval(message, selfId);
        } else if (state.expiresAt !== undefined) {
          const expiresAt = state.expiresAt;
          const updated = await repository.update(state.id, (current) => {
            if (current.historyCursor !== message.historyCursor) return current;
            const next = {
              ...current,
              expiresAt: Math.min(current.expiresAt ?? expiresAt, expiresAt),
            };
            delete next.expiresAfterReadMs;
            return next;
          });
          if (generation !== this.generation) return;
          if (updated)
            stores.messages.getState().update(message.conversationId, state.id, () => updated);
        }
      }
    }
  }

  /** Start pending imported timers only for messages the UI reports as visible. */
  async readHistoryMessages(
    conversationId: ConversationId,
    ids: readonly MessageId[],
  ): Promise<void> {
    const { backend, repository, stores, clock } = this.deps;
    if (!backend.readHistory) return;
    const generation = this.generation;
    const claimed = [...new Set(ids)].filter((id) => !this.readingHistory.has(id));
    for (const id of claimed) this.readingHistory.add(id);
    try {
      const selected = new Map<MessageId, Message>();
      for (const id of claimed) {
        const message = await repository.get(id);
        if (generation !== this.generation) return;
        if (
          message?.conversationId === conversationId &&
          message.historyCursor &&
          message.expiresAfterReadMs &&
          !message.deleted &&
          message.expiresAt === undefined
        )
          selected.set(id, message);
      }
      if (!selected.size) return;
      const states = await backend.readHistory(
        [...selected.values()].flatMap((message) =>
          message.historyCursor ? [{ id: message.id, cursor: message.historyCursor }] : [],
        ),
      );
      if (generation !== this.generation) return;
      for (const state of states) {
        const original = selected.get(state.id);
        if (!original) continue;
        if (
          state.expiresAt !== undefined &&
          (!Number.isSafeInteger(state.expiresAt) || state.expiresAt <= 0)
        )
          throw new Error('History timer response has an invalid deadline');
        const current = await repository.get(state.id);
        if (generation !== this.generation) return;
        if (!current || current.historyCursor !== original.historyCursor) continue;
        if (
          state.unavailable ||
          (state.expiresAt !== undefined && state.expiresAt <= clock.now())
        ) {
          await repository.delete(state.id);
          if (generation !== this.generation) return;
          this.rememberPurged(state.id);
          stores.messages.getState().remove(conversationId, state.id);
          const selfId = this.selfId();
          if (selfId) stores.conversations.getState().applyRemoval(current, selfId);
          continue;
        }
        const expiresAt = state.expiresAt;
        if (expiresAt === undefined || !Number.isSafeInteger(expiresAt) || expiresAt <= 0)
          throw new Error('History timer response has no valid deadline');
        const updated = await repository.update(state.id, (message) => {
          if (message.historyCursor !== original.historyCursor) return message;
          const next = {
            ...message,
            expiresAt: Math.min(message.expiresAt ?? expiresAt, expiresAt),
          };
          delete next.expiresAfterReadMs;
          return next;
        });
        if (generation !== this.generation) return;
        if (updated) stores.messages.getState().update(conversationId, state.id, () => updated);
        this.schedulePurge(expiresAt - clock.now());
      }
    } catch (error) {
      if (generation === this.generation) this.onError(error, 'starting history expiration failed');
    } finally {
      for (const id of claimed) this.readingHistory.delete(id);
    }
  }

  /**
   * Marks everything in a conversation as read: advances the cursor, clears
   * badges and (if enabled) sends read receipts for the newly read messages.
   */
  async markConversationRead(conversationId: ConversationId): Promise<void> {
    const { repository, stores } = this.deps;
    // A hand-set "unread" flag is local only and always ends here.
    stores.local.getState().setMarkedUnread(conversationId, false);
    const selfId = this.selfId();
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const unread = await repository.listAfter(conversationId, cursor);
    const latest = unread.at(-1)?.seq;
    if (latest === undefined) {
      log.info('read sync skipped', { reason: 'no-unread' });
      stores.conversations.getState().setUnread(conversationId, { count: 0, mentions: 0 });
      return;
    }
    if (!stores.conversations.getState().markRead(conversationId, latest)) {
      log.info('read sync skipped', { reason: 'already-read' });
      return;
    }
    await repository.setReadCursor(conversationId, latest);
    const toAck = unread.filter((m) => m.authorId !== selfId && m.kind === 'normal');
    if (toAck.length === 0) {
      log.info('read sync skipped', { reason: 'nothing-from-others' });
      return;
    }
    // Reading is always synced to the user's own devices (that is what marks
    // it read on their phone). A message request is read without telling the
    // sender anything: its receipts go out only if the user accepts
    // (`sendHeldReadReceipts`).
    await this.sendReadReceipts(
      conversationId,
      toAck.map((m) => ({ authorId: m.authorId, sentAt: m.sentAt })),
      selectMessageRequestState(stores, conversationId) === 'accepted',
    );
  }

  /**
   * Read receipts for what the user already read in a conversation they have
   * just accepted: while it was a message request nothing was sent (like
   * Signal Desktop, which sends them for the whole conversation on accept).
   * Only messages the user has actually read; unread ones get theirs when
   * they are read, as usual.
   */
  async sendHeldReadReceipts(conversationId: ConversationId): Promise<void> {
    const { repository, stores } = this.deps;
    const selfId = this.selfId();
    const cursor = stores.conversations.getState().readCursors[conversationId];
    if (cursor === undefined) return;
    const read = (await repository.listAfter(conversationId, 0)).filter(
      (m) =>
        m.authorId !== selfId &&
        m.kind === 'normal' &&
        !m.deleted &&
        m.seq !== undefined &&
        m.seq <= cursor,
    );
    if (read.length === 0) return;
    // The reads were already synced to the user's devices when they happened:
    // only the receipts to the senders are new now. (Where they're not
    // allowed nothing is sent; where they are, signal-cli sends the receipt
    // and, harmlessly, repeats the sync.)
    await this.sendReadReceipts(
      conversationId,
      read.map((m) => ({ authorId: m.authorId, sentAt: m.sentAt })),
      true,
      false,
    );
  }

  /**
   * Tells Signal these messages were read. A receipt to the senders goes out
   * only when the chat is `accepted` and the effective setting allows it: the
   * phone's when it has told us, Snowdrop's own otherwise. Otherwise, with a
   * signal-cli that can (`supportsReadSync`), only the user's own devices are
   * told (`syncOnly`), so the messages still stop being unread on the phone.
   * An older signal-cli can't send the sync alone, so there nothing is sent
   * when a receipt isn't allowed (the behaviour before read sync existed).
   * While the phone's settings are still being read everything waits
   * (`heldReceipts`) instead of going out on a guess, and is decided the
   * moment the answer is in. `syncWithoutReceipt: false` (receipts for reads
   * already synced) sends nothing when no receipt is allowed.
   */
  private async sendReadReceipts(
    conversationId: ConversationId,
    messages: MessageRef[],
    accepted: boolean,
    syncWithoutReceipt = true,
  ): Promise<void> {
    const { backend, stores } = this.deps;
    const privacy = effectivePrivacy(
      stores.settings.getState().behaviour,
      stores.session.getState().phonePrivacy,
    );
    if (!privacy.settled) {
      log.info('read sync held', { reason: 'pending', n: messages.length });
      this.heldReceipts.push({ conversationId, messages, accepted, syncWithoutReceipt });
      return;
    }
    const receipt = accepted && privacy.sendReadReceipts;
    if (!receipt && (!syncWithoutReceipt || backend.supportsReadSync?.() !== true)) {
      log.info('read sync skipped', {
        reason: !accepted ? 'not-accepted' : 'receipts-off',
        n: messages.length,
      });
      return;
    }
    try {
      const summary = await backend.markRead(
        conversationId,
        messages,
        receipt ? undefined : { syncOnly: true },
      );
      // Types and counts only. Anything but a success is shown at the default log level: a read
      // that clears here but stays unread on the phone has to leave a trace.
      const fields = {
        n: messages.length,
        mode: receipt ? 'receipt' : 'sync-only',
        receipt: summary?.receipt ?? 'unreported',
        sync: summary?.sync ?? 'unreported',
      };
      const ok = (v: string) => v === 'success' || v === 'none' || v === 'unreported';
      if (ok(fields.receipt) && ok(fields.sync)) log.info('read sync sent', fields);
      else log.warn('read sync sent', fields);
    } catch (error) {
      this.onError(error, 'read receipt failed');
    }
  }

  private flushHeldReceipts(): void {
    const held = this.heldReceipts;
    this.heldReceipts = [];
    for (const { conversationId, messages, accepted, syncWithoutReceipt } of held) {
      void this.sendReadReceipts(conversationId, messages, accepted, syncWithoutReceipt);
    }
  }

  // ─── Phone privacy settings ───────────────────────────────────────────

  /**
   * Reads the privacy settings the user's phone syncs to this device (only
   * where the backend can), or marks them unsupported. Never throws: a failed
   * read leaves them pending (nothing depending on them is sent) and retries.
   */
  private async refreshPhonePrivacy(): Promise<void> {
    const { backend, stores } = this.deps;
    const session = stores.session.getState();
    if (backend.supportsPhonePrivacy?.() !== true || !backend.readPhonePrivacy) {
      session.setPhonePrivacy({ status: 'unsupported', values: UNKNOWN_PHONE_PRIVACY });
      return;
    }
    // A daemon that newly reports support starts from "unknown", not local settings.
    if (session.phonePrivacy.status === 'unsupported') {
      session.setPhonePrivacy({ status: 'pending', values: UNKNOWN_PHONE_PRIVACY });
    }
    const seq = ++this.privacyReadSeq;
    try {
      const values = await backend.readPhonePrivacy();
      if (seq !== this.privacyReadSeq) return;
      this.privacyRetries = 0;
      stores.session.getState().setPhonePrivacy({ status: 'ready', values });
    } catch (error) {
      if (seq !== this.privacyReadSeq) return;
      this.onError(error, 'reading the phone privacy settings failed');
      this.privacyRetryCancel?.();
      if (this.privacyRetries >= PHONE_PRIVACY_MAX_RETRIES) return;
      this.privacyRetries++;
      this.privacyRetryCancel = this.deps.scheduler.setTimeout(() => {
        this.privacyRetryCancel = null;
        void this.refreshPhonePrivacy();
      }, PHONE_PRIVACY_RETRY_MS);
    }
  }

  /**
   * Settings → Privacy: changes read receipts / typing indicators / link
   * previews on the phone's account (stored by signal-cli and synced to the
   * phone, as Signal Desktop does). Applies at once and reverts on failure.
   * Returns false when the phone's settings aren't known (the caller then
   * edits the local setting) or the change failed.
   */
  async updatePhonePrivacy(patch: PhonePrivacyPatch): Promise<boolean> {
    const { backend, stores } = this.deps;
    const current = stores.session.getState().phonePrivacy;
    if (current.status !== 'ready' || !backend.updatePhonePrivacy) return false;
    const previous = current.values;
    stores.session.getState().setPhonePrivacy({
      status: 'ready',
      values: { ...previous, ...patch },
    });
    try {
      await backend.updatePhonePrivacy(patch);
      return true;
    } catch (error) {
      this.onError(error, 'privacy setting update failed');
      // Put back only what this change touched, unless a newer read replaced it.
      const now = stores.session.getState().phonePrivacy;
      if (now.status === 'ready') {
        const reverted = { ...now.values };
        for (const key of Object.keys(patch) as (keyof PhonePrivacyPatch)[]) {
          if (reverted[key] === patch[key]) reverted[key] = previous[key];
        }
        stores.session.getState().setPhonePrivacy({ status: 'ready', values: reverted });
      }
      return false;
    }
  }

  /**
   * Settings → Profile: saves the user's own name, about and photo, then
   * shows them at once. Returns null on success or a short message to show
   * inline; nothing changes on failure. The photo isn't something signal-cli
   * lists back, so what was just set is kept for this session (a restart
   * shows whatever signal-cli reports).
   */
  async updateProfile(update: ProfileUpdate): Promise<string | null> {
    const { backend, stores } = this.deps;
    if (!backend.updateProfile) return "This connection can't change your profile.";
    const before = stores.session.getState().self;
    try {
      const fresh = await backend.updateProfile(update);
      const self: Contact = { ...fresh, isSelf: true };
      if (update.avatar) {
        self.avatarUrl = `data:${update.avatar.contentType};base64,${update.avatar.base64}`;
      } else if (update.avatar === undefined && before?.avatarUrl) {
        self.avatarUrl = before.avatarUrl;
      } else delete self.avatarUrl;
      stores.session.getState().setSelf(self);
      stores.contacts.getState().upsert(self);
      return null;
    } catch (error) {
      this.onError(error, 'profile update failed');
      return "Couldn't save your profile. Check your connection and try again.";
    }
  }

  private isViewing(conversationId: ConversationId): boolean {
    const ui = this.deps.stores.ui.getState();
    // Only when the newest messages are actually on screen (the list reports scrolling away).
    return (
      ui.windowFocused &&
      uiSelectors.selectedConversation(ui) === conversationId &&
      !uiSelectors.scrolledUp(conversationId)(ui)
    );
  }

  // ─── Events ────────────────────────────────────────────────────────────

  private subscribe(): void {
    const { backend } = this.deps;
    const on = <E extends keyof BackendEvents>(
      event: E,
      /** `live` is false when the event was parked behind the initial sync. */
      handler: (payload: BackendEvents[E], live: boolean) => Promise<void> | void,
      immediate = false,
    ): void => {
      this.unsubscribers.push(
        backend.on(event, (payload) => {
          if (immediate) {
            void this.run(event, () => handler(payload, true));
            return;
          }
          if (this.gated) this.backlog.push({ event, task: () => handler(payload, false) });
          else this.enqueue(event, () => handler(payload, true));
        }),
      );
    };

    // Status and typing are ephemeral: applied immediately, not queued.
    on(
      'status',
      (status) => {
        // A reconnect after being offline means signal-cli may have queued
        // messages again; the initial `start()` call above already covers
        // the very first connect (its status goes 'connecting' → 'online',
        // never through 'offline').
        if (status === 'online' && this.deps.stores.session.getState().status === 'offline') {
          this.startCatchUp();
          this.armCatchUpQuiet();
          // The daemon may have restarted: read the phone's settings again.
          void this.refreshPhonePrivacy();
        }
        this.deps.stores.session.getState().setStatus(status);
      },
      true,
    );
    // Any arrival, parked or not, means the backlog is still flowing.
    this.unsubscribers.push(
      backend.on('message', () => {
        this.catchUpTracker.onMessage();
        this.notificationHold.onMessage();
      }),
    );
    // The phone's privacy settings changed (patches/signal-cli 0022). Ephemeral:
    // applied at once, never parked behind the initial sync.
    on(
      'phonePrivacyChanged',
      () => {
        void this.refreshPhonePrivacy();
      },
      true,
    );
    // Held read receipts leave (or are dropped) the moment the settings are known.
    this.unsubscribers.push(
      this.deps.stores.session.subscribe((state, prev) => {
        if (state.phonePrivacy !== prev.phonePrivacy && state.phonePrivacy.status !== 'pending') {
          this.flushHeldReceipts();
        }
      }),
    );
    // signal-cli reconnected to the server by itself (after a sleep or a network
    // change; our own stream never dropped) and is draining what queued up
    // (patches/signal-cli 0025): catch up again, like after an offline period.
    // Applied at once, not queued: behind a message backlog it would come too
    // late to cover those messages. During the initial sync the trackers are
    // already catching up and the quiet period must not start yet, so it is
    // ignored there.
    on(
      'catchingUp',
      () => {
        if (this.gated) return;
        this.startCatchUp();
        this.armCatchUpQuiet();
      },
      true,
    );
    // Queued (and parked behind the initial sync) like messages, so catch-up
    // ends only once every message before it has reached the stores.
    on('caughtUp', () => {
      this.catchUpTracker.finish();
      this.notificationHold.finish();
    });
    on(
      'typing',
      (e) => {
        this.deps.stores.typing
          .getState()
          .setTyping(e.conversationId, e.authorId, e.typing, this.deps.clock.now());
        this.schedulePrune();
      },
      true,
    );
    on(
      'contactUpdated',
      (contact) => {
        this.deps.stores.contacts.getState().upsert(contact);
      },
      true,
    );
    // Ephemeral, like status/typing: a stale answer waiting behind the
    // initial sync backlog would show "Getting it from your phone…" long
    // after it was actually resolved.
    on(
      'attachmentBackfill',
      (e) => {
        this.deps.stores.session
          .getState()
          .setAttachmentBackfill(`${e.targetAuthorId}\u0000${e.targetSentAt}`, {
            status: e.status,
            attachmentIds: e.attachmentIds,
          });
      },
      true,
    );
    on('conversationUpdated', (conv) => {
      this.upsertConversation(conv);
    });
    on('message', (m, live) => this.onMessage(m, live));
    on('messageEdited', (e) =>
      this.updateMessage(e.conversationId, messageId(e.authorId, e.targetSentAt), (m) =>
        applyEdit(m, {
          body: e.body,
          ranges: e.ranges,
          editedAt: e.editedAt,
          ...(e.previews ? { previews: e.previews } : {}),
        }),
      ),
    );
    on('messageDeleted', (e) =>
      this.removeContent(e.conversationId, messageId(e.authorId, e.targetSentAt), e.deletedBy),
    );
    on('messagePinned', (e) =>
      this.updateMessage(e.conversationId, messageId(e.targetAuthorId, e.targetSentAt), (m) => {
        if (e.pinned) return { ...m, pinned: true };
        const { pinned: _pinned, ...rest } = m;
        return rest;
      }),
    );
    on('reaction', (e) =>
      this.updateMessage(e.conversationId, messageId(e.targetAuthorId, e.targetSentAt), (m) => ({
        ...m,
        reactions: applyReaction(m.reactions, e.reaction, e.remove),
      })),
    );
    on('pollVote', (e, live) => this.onPollVote(e, live));
    on('pollTerminate', (e, live) => this.onPollTerminate(e, live));
    on('receipt', (e) => this.onReceipt(e));
    on('readSync', (e) => this.onReadSync(e));
    // Queued like everything else (and parked behind the initial-sync gate),
    // so the transport only learns a position once everything before it has
    // been written to the repository. A lost ack just means re-delivery.
    on('checkpoint', (e) => {
      this.deps.backend.acknowledge?.(e.cursor);
    });
  }

  private async run(event: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (error) {
      // One bad event must not stall the queue.
      this.onError(error, `sync: ${event} handler failed`);
    }
  }

  private async onMessage(incoming: Message, live: boolean): Promise<void> {
    const { repository, stores } = this.deps;
    // A re-delivered (replayed) disappearing message must not come back
    // after it has been purged, nor flash in if it is already due.
    if (this.purged.has(incoming.id)) return;
    if (incoming.expiresAt !== undefined && incoming.expiresAt <= this.deps.clock.now()) {
      this.rememberPurged(incoming.id);
      return;
    }
    // A delete/reaction/edit/pin that beat this message (out of order, or a
    // race with our own send) is replayed before the message is ever stored
    // or emitted, so it never has a window to show up "undone".
    // Someone the user deleted wrote again: it is a fresh message request.
    if (incoming.authorId !== this.selfId())
      stores.local.getState().clearDeleted(incoming.conversationId);
    const queued = this.pendingOps.take(incoming.id, this.deps.clock.now());
    const toStore = queued.reduce((m, op) => op(m), incoming);
    const { message, created } = await repository.upsert(toStore, mergeDuplicate);
    const id = message.conversationId;
    // Our own message, including one sent from the phone, accepts the chat.
    acceptForOutgoing(stores, [message], this.deps.clock.now());
    stores.messages.getState().appendLive(message);
    // System lines (decrypt failures, timer changes) are stored and shown
    // like any other message, but must never move a chat up or (below)
    // create one on their own — only a real message does either.
    if (message.kind === 'normal') {
      stores.conversations.getState().bumpActivity(id, message.sentAt);
      this.confirmedReal.add(id);
    }
    stores.conversations.getState().noteLatest(message);
    stores.typing.getState().setTyping(id, message.authorId, false, this.deps.clock.now());
    if (message.kind === 'normal' && !stores.conversations.getState().byId[id])
      this.ensureConversation(message);
    if (message.expiresAt !== undefined)
      this.schedulePurge(message.expiresAt - this.deps.clock.now());
    // A re-delivery must not count twice or re-notify plugins.
    if (!created) return;
    // New activity brings an archived chat back to the list, like Signal Desktop
    // (it does so for a muted one too, unless "keep muted chats archived" is on).
    if (message.kind === 'normal') stores.local.getState().unarchive(id);
    await this.updateReadState(message);
    this.events.emit('message', message);
    this.events.emit('messageArrived', { message, live });
  }

  private async updateReadState(message: Message): Promise<void> {
    const { repository, stores } = this.deps;
    const id = message.conversationId;
    const selfId = this.selfId();
    if (!selfId || message.seq === undefined) return;
    if (message.authorId === selfId) {
      // Sent from another of our devices: we've evidently read up to here.
      if (stores.conversations.getState().markRead(id, message.seq)) {
        await repository.setReadCursor(id, message.seq);
      }
    } else if (this.isViewing(id)) {
      await this.markConversationRead(id);
    } else {
      stores.conversations.getState().applyIncoming(message, selfId);
    }
  }

  /**
   * Protocol fields only; local state lives in localStore and is untouched.
   * A direct conversation neither already listed nor yet confirmed to have
   * a real message (`confirmedReal` — set once `seedConversation` or
   * `dropStaleDirects` has actually checked the repository) is never
   * created from this alone: a stale persisted peer's own profile/timer
   * refresh (`onContactChanged`, `applyTimer`) must not resurrect it
   * between one `dropStaleDirects` pass and the next. A genuinely new DM is
   * still listed immediately, through the real message that justifies it
   * (`ensureConversation`, called from `onMessage`), which refreshes the
   * full list right after anyway.
   */
  private upsertConversation(conv: Conversation): void {
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
  private ensureConversation(message: Message): void {
    const parsed = parseConversationId(message.conversationId);
    const selfId = this.selfId();
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

  private async updateMessage(
    conversationId: ConversationId,
    id: MessageId,
    fn: (m: Message) => Message,
  ): Promise<void> {
    const updated = await this.deps.repository.update(id, fn);
    if (!updated) {
      // The target isn't stored yet (out of order, or a race with our own
      // send before commitOutgoing): park it instead of dropping it, unless
      // it's a disappearing message we already purged — that tombstone must
      // not be undone by a late op.
      if (!this.purged.has(id)) this.pendingOps.hold(id, fn, this.deps.clock.now());
      return;
    }
    this.deps.stores.messages.getState().update(conversationId, id, fn);
    // Keep the sidebar preview in step with edits/deletions of the newest message.
    const conversations = this.deps.stores.conversations.getState();
    const latest = conversations.lastMessage[conversationId];
    if (latest?.id === id) conversations.noteLatest(fn(latest));
  }

  /**
   * A vote on a poll. Like the other message operations it is parked when
   * the poll isn't stored yet. It only ever applies to a poll in the
   * conversation it was sent to, so a vote can't reach into another chat.
   */
  private async onPollVote(e: BackendEvents['pollVote'], live: boolean): Promise<void> {
    const id = messageId(e.targetAuthorId, e.targetSentAt);
    const vote = {
      voterId: e.voterId,
      optionIndexes: e.optionIndexes,
      voteCount: e.voteCount,
      at: e.at,
    };
    const apply = (m: Message): Message =>
      m.conversationId === e.conversationId ? applyPollVote(m, vote) : m;
    const before = await this.deps.repository.get(id);
    // Nothing would change (a stale, invalid or too-late vote): nothing to store or announce.
    if (before && apply(before) === before) return;
    await this.updateMessage(e.conversationId, id, apply);
    const selfId = this.selfId();
    if (!before || selfId === undefined) return;
    // Only someone else voting on a poll of ours is news, and only a vote that chooses something.
    if (before.authorId === selfId && e.voterId !== selfId && e.optionIndexes.length > 0) {
      const message = await this.deps.repository.get(id);
      if (message)
        this.events.emit('pollActivity', { kind: 'vote', message, actorId: e.voterId, live });
    }
  }

  /**
   * A poll being ended. Only its author can end it, so the poll is the one
   * written by whoever sent this. The conversation gets Signal's "X ended
   * the poll" line, once, when the end is first applied.
   */
  private async onPollTerminate(e: BackendEvents['pollTerminate'], live: boolean): Promise<void> {
    const id = messageId(e.authorId, e.targetSentAt);
    const apply = (m: Message): Message =>
      m.conversationId === e.conversationId ? applyPollTerminate(m) : m;
    const before = await this.deps.repository.get(id);
    if (before && apply(before) === before) return;
    await this.updateMessage(e.conversationId, id, apply);
    const question = before?.poll?.question;
    if (before?.conversationId !== e.conversationId || question === undefined) return;
    const { stores, clock } = this.deps;
    const selfId = this.selfId();
    const name =
      e.authorId === selfId
        ? 'You'
        : (stores.contacts.getState().byId[e.authorId]?.name ?? UNKNOWN_CONTACT_NAME);
    await this.onMessage(
      {
        id: systemMessageId(e.authorId, e.at, 'poll-end'),
        conversationId: e.conversationId,
        authorId: e.authorId,
        sentAt: e.at,
        receivedAt: clock.now(),
        body: '',
        ranges: [],
        attachments: [],
        reactions: [],
        status: 'sent',
        kind: 'system',
        systemText: pollEndedText(name, question),
      },
      live,
    );
    const message = await this.deps.repository.get(id);
    if (message && e.authorId !== selfId)
      this.events.emit('pollActivity', { kind: 'end', message, actorId: e.authorId, live });
  }

  private async removeContent(
    conversationId: ConversationId,
    id: MessageId,
    deletedBy?: string,
  ): Promise<void> {
    const before = await this.deps.repository.get(id);
    if (!before) {
      if (!this.purged.has(id)) {
        this.pendingOps.hold(id, (m) => applyDelete(m, deletedBy), this.deps.clock.now());
      }
      return;
    }
    await this.updateMessage(conversationId, id, (m) => applyDelete(m, deletedBy));
    const selfId = this.selfId();
    if (selfId) this.deps.stores.conversations.getState().applyRemoval(before, selfId);
  }

  private async onReceipt(e: BackendEvents['receipt']): Promise<void> {
    const selfId = this.selfId();
    if (!selfId) return;
    const status = RECEIPT_STATUS[e.type];
    for (const sentAt of e.sentAts) {
      const id = messageId(selfId, sentAt);
      const advance = (m: Message): Message => {
        const next = advanceStatus(m.status, status);
        // Narrowed by RECEIPT_STATUS's range: every value it maps to is
        // 'delivered' or 'read', never 'pending'/'sent'/'failed'.
        const receipts =
          status === 'delivered' || status === 'read'
            ? applyRecipientReceipt(m.receipts, e.authorId, status, this.deps.clock.now())
            : m.receipts;
        if (next === m.status && receipts === m.receipts) return m;
        return { ...m, status: next, ...(receipts ? { receipts } : {}) };
      };
      const updated = await this.deps.repository.update(id, advance);
      if (!updated) {
        // Our send hasn't been acknowledged yet; SendService applies this on reconcile.
        this.receipts.hold(sentAt, e.authorId, status, this.deps.clock.now());
        continue;
      }
      this.deps.stores.messages.getState().update(updated.conversationId, id, advance);
    }
  }

  private async onReadSync(e: BackendEvents['readSync']): Promise<void> {
    const latestByConv = new Map<ConversationId, number>();
    for (const ref of e.messages) {
      const m = await this.deps.repository.get(messageId(ref.authorId, ref.sentAt));
      if (m?.seq === undefined) continue;
      latestByConv.set(m.conversationId, Math.max(latestByConv.get(m.conversationId) ?? 0, m.seq));
    }
    const conversations = this.deps.stores.conversations.getState();
    for (const [conv, seq] of latestByConv) {
      if ((conversations.readCursors[conv] ?? 0) >= seq) continue;
      conversations.setReadCursors({ [conv]: seq });
      await this.deps.repository.setReadCursor(conv, seq);
      await this.recomputeUnread(conv);
    }
  }

  // ─── Timers ────────────────────────────────────────────────────────────

  private schedulePrune(): void {
    this.pruneTimer?.();
    this.pruneTimer = null;
    const next = this.deps.stores.typing.getState().prune(this.deps.clock.now());
    if (next === undefined) return;
    this.pruneTimer = this.deps.scheduler.setTimeout(() => {
      this.pruneTimer = null;
      this.schedulePrune();
    }, next - this.deps.clock.now());
  }

  private nextPurgeAt = Infinity;

  /** Purges expired messages after `delayMs` (and then periodically while running). */
  private schedulePurge(delayMs: number): void {
    if (!this.startPromise) return;
    const at = this.deps.clock.now() + Math.max(0, delayMs);
    if (this.purgeTimer && at >= this.nextPurgeAt) return;
    this.purgeTimer?.();
    this.nextPurgeAt = at;
    this.purgeTimer = this.deps.scheduler.setTimeout(() => {
      this.purgeTimer = null;
      this.nextPurgeAt = Infinity;
      this.queue = this.queue.then(() =>
        this.run('purge', async () => {
          await this.purgeExpired();
        }),
      );
      this.schedulePurge(this.deps.purgeIntervalMs ?? 30_000);
    }, at - this.deps.clock.now());
  }

  /** Deletes disappearing messages whose time is up, locally and in the UI. */
  async purgeExpired(): Promise<number> {
    const { repository, stores, clock } = this.deps;
    const selfId = this.selfId();
    const expired = await repository.expired(clock.now(), 500);
    for (const m of expired) {
      await repository.delete(m.id);
      this.rememberPurged(m.id);
      stores.messages.getState().remove(m.conversationId, m.id);
      if (selfId) stores.conversations.getState().applyRemoval(m, selfId);
    }
    return expired.length;
  }

  /**
   * Tombstones of purged disappearing messages (bounded, oldest evicted).
   * In memory only: after a reload, a replayed message is already past its
   * `expiresAt` (adapters derive it from the server receive time) and is
   * dropped by the check in onMessage instead.
   */
  private readonly purged = new Set<MessageId>();

  private rememberPurged(id: MessageId): void {
    this.purged.add(id);
    if (this.purged.size > PURGED_TOMBSTONES) {
      const oldest = this.purged.values().next().value;
      if (oldest !== undefined) this.purged.delete(oldest);
    }
  }

  /** Consumes a refresh requested while one was in flight. */
  private takeRefreshRequest(): boolean {
    const requested = this.refreshAgain;
    this.refreshAgain = false;
    return requested;
  }

  /** Re-lists conversations. Concurrent requests coalesce into one follow-up, never get dropped. */
  private refreshConversations(): Promise<void> {
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
    if (parseConversationId(conv.id)?.kind !== 'direct' || conv.historyHasMessages) return false;
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
}

/** Adapters throw typed errors with a string `kind` (no import: core can't depend on adapters). */
function errorKindOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return null;
  return typeof error.kind === 'string' ? error.kind : null;
}
