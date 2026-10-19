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
import type { BackendEvents, ChatBackend } from '@/core/backend';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyReaction,
  colorForId,
  directConversationId,
  mergeDuplicate,
  messageId,
  parseConversationId,
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
import type { MessageRepository } from '@/core/persistence';
import { computeUnread, uiSelectors, type Stores } from '@/core/stores';
import { CatchUpTracker } from './CatchUpTracker';
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
  /** A pending steady-state retry after `account-unavailable` (see `doStart`'s catch). */
  private accountRetryCancel: Cancel | null = null;

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
    this.catchUpTracker.start();
    try {
      await backend.connect();
      await this.initialSync();
    } catch (error) {
      // Drop the subscriptions so a retry doesn't double-subscribe, but keep the
      // backlog: those envelopes are gone from the daemon once delivered.
      this.unsubscribeAll();
      this.catchUpTracker.dispose();
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
    this.catchUpTracker.armQuiet();
    this.schedulePurge(0);
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
    this.pruneTimer?.();
    this.purgeTimer?.();
    this.pruneTimer = null;
    this.purgeTimer = null;
    this.catchUpTracker.dispose();
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
    const [self, contacts, conversations] = await Promise.all([
      backend.getSelf(),
      backend.listContacts(),
      backend.listConversations(),
    ]);
    stores.session.getState().setSelf(self);
    stores.contacts.getState().upsertMany([self, ...contacts]);
    stores.conversations.getState().upsertMany(conversations);

    await this.recoverHistoryTimers();
    const cursors = await repository.getReadCursors();
    await Promise.all(
      conversations.map(async (conv) => {
        cursors.set(conv.id, await this.seedConversation(conv, cursors.get(conv.id)));
      }),
    );
    while ((await this.purgeExpired()) === 500) {
      // Drain expired cache entries before setting ready or exposing message previews.
    }
    stores.conversations.getState().setReadCursors(Object.fromEntries(cursors));
    await Promise.all(conversations.map((c) => this.recomputeUnread(c.id)));
  }

  /** Makes sure a conversation has local history and a read cursor (a seq). */
  private async seedConversation(
    conv: Conversation,
    storedCursor: number | undefined,
  ): Promise<number> {
    const { backend, repository, stores } = this.deps;
    let cursor = storedCursor;
    if (backend.fetchHistory && (await repository.count(conv.id)) === 0) {
      const page = await backend.fetchHistory(conv.id, { limit: this.deps.seedPageSize ?? 50 });
      const stored = await repository.upsertMany(page.messages, {
        backfill: false,
        merge: mergeDuplicate,
      });
      if (cursor === undefined && page.readUpTo !== undefined) {
        const readUpTo = page.readUpTo;
        // Convert the backend's timestamp-based position into our seq space.
        const read = stored.filter((m) => m.sentAt <= readUpTo);
        cursor = read.at(-1)?.seq ?? (stored[0]?.seq ?? 1) - 1;
      }
    }
    const latest = await repository.latest(conv.id);
    if (latest) {
      stores.conversations.getState().bumpActivity(conv.id, latest.receivedAt);
      stores.conversations.getState().noteLatest(latest);
    }
    // First sight with no read info: everything stored *before this session* is
    // read. Live events are gated until after this, so they still count.
    cursor ??= latest?.seq ?? 0;
    if (cursor !== storedCursor) await repository.setReadCursor(conv.id, cursor);
    return cursor;
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
    const { repository, stores, backend } = this.deps;
    const selfId = this.selfId();
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const unread = await repository.listAfter(conversationId, cursor);
    const latest = unread.at(-1)?.seq;
    if (latest === undefined) {
      stores.conversations.getState().setUnread(conversationId, { count: 0, mentions: 0 });
      return;
    }
    if (!stores.conversations.getState().markRead(conversationId, latest)) return;
    await repository.setReadCursor(conversationId, latest);
    const toAck = unread.filter((m) => m.authorId !== selfId && m.kind === 'normal');
    if (toAck.length > 0 && stores.settings.getState().behaviour.sendReadReceipts) {
      try {
        await backend.markRead(
          conversationId,
          toAck.map((m) => ({ authorId: m.authorId, sentAt: m.sentAt })),
        );
      } catch (error) {
        this.onError(error, 'read receipt failed');
      }
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
          this.catchUpTracker.start();
          this.catchUpTracker.armQuiet();
        }
        this.deps.stores.session.getState().setStatus(status);
      },
      true,
    );
    // Any arrival, parked or not, means the backlog is still flowing.
    this.unsubscribers.push(
      backend.on('message', () => {
        this.catchUpTracker.onMessage();
      }),
    );
    // Queued (and parked behind the initial sync) like messages, so catch-up
    // ends only once every message before it has reached the stores.
    on('caughtUp', () => {
      this.catchUpTracker.finish();
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
      // Protocol fields only; local state lives in localStore and is untouched.
      this.deps.stores.conversations.getState().upsert(conv);
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
    const queued = this.pendingOps.take(incoming.id, this.deps.clock.now());
    const toStore = queued.reduce((m, op) => op(m), incoming);
    const { message, created } = await repository.upsert(toStore, mergeDuplicate);
    const id = message.conversationId;
    stores.messages.getState().appendLive(message);
    stores.conversations.getState().bumpActivity(id, message.receivedAt);
    stores.conversations.getState().noteLatest(message);
    stores.typing.getState().setTyping(id, message.authorId, false, this.deps.clock.now());
    if (!stores.conversations.getState().byId[id]) this.ensureConversation(message);
    if (message.expiresAt !== undefined)
      this.schedulePurge(message.expiresAt - this.deps.clock.now());
    // A re-delivery must not count twice or re-notify plugins.
    if (!created) return;
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
   * A message for a conversation we don't know yet (someone new messaged
   * us, or we were added to a group). DMs can be synthesised immediately so
   * the message is visible; groups need the backend's metadata.
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
        lastActivityAt: message.receivedAt,
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
        return next === m.status ? m : { ...m, status: next };
      };
      const updated = await this.deps.repository.update(id, advance);
      if (!updated) {
        // Our send hasn't been acknowledged yet; SendService applies this on reconcile.
        this.receipts.hold(sentAt, status, this.deps.clock.now());
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
          const conversations = await this.deps.backend.listConversations();
          this.deps.stores.conversations.getState().upsertMany(conversations);
        } catch (error) {
          this.onError(error, 'conversation refresh failed');
        }
      } while (this.takeRefreshRequest());
      this.refreshing = null;
    })();
    return this.refreshing;
  }
}

/** Adapters throw typed errors with a string `kind` (no import: core can't depend on adapters). */
function errorKindOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null || !('kind' in error)) return null;
  return typeof error.kind === 'string' ? error.kind : null;
}
