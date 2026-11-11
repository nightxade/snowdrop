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
import type { BackendEvents, ChatBackend, PhonePrivacyPatch, ProfileUpdate } from '@/core/backend';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  isTooOldToEdit,
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
  type ErrorKind,
  type Scheduler,
  type Unsubscribe,
  toAppError,
  ignored,
} from '@/core/lib';
import { latestRealMessage, type MessageRepository } from '@/core/persistence';
import { refreshPreviewAfterRemoval } from './sidebarPreview';
import {
  acceptForOutgoing,
  isDeletedRequest,
  selectMessageRequestState,
  UNKNOWN_PHONE_PRIVACY,
  uiSelectors,
  UNKNOWN_CONTACT_NAME,
  type Stores,
} from '@/core/stores';
import { CatchUpTracker, NOTIFICATION_HOLD_CEILING_MS } from './CatchUpTracker';
import { PendingOpsBuffer, PENDING_OPS_MAX, PENDING_OPS_TTL_MS } from './PendingOpsBuffer';
import { ReactionWatch } from './ReactionWatch';
import { PhonePrivacyService } from './PhonePrivacyService';
import { ProfileService } from './ProfileService';
import { ReadStateService } from './ReadStateService';
import { ReceiptBuffer } from './ReceiptBuffer';
import type { PostConnectRunner } from './PostConnect';
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
  /** Shared with SendService: told when a reaction is taken back. */
  reactionWatch?: ReactionWatch;
  /**
   * Read state (marking read, receipts, read syncs, unread recount). Built here
   * when not given; `createSnowdrop` builds it so others can share it.
   */
  readState?: ReadStateService;
  /** The phone's privacy settings. Built here when not given; `createSnowdrop` builds it so Settings can use it. */
  phonePrivacy?: PhonePrivacyService;
  /** The user's own profile. Built here when not given. */
  profile?: ProfileService;
  onError?: ErrorReporter;
  /** The app's steps for after a successful connect (see PostConnect); run after every one. */
  postConnect?: PostConnectRunner;
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
  /**
   * Someone else reacted to a message the user sent, once it has been applied:
   * `react` is a new reaction (replacing that person's earlier one, if any),
   * `unreact` is one taken back. `message` is the target as it now stands and
   * `emoji` the reaction that arrived or went. `at` is when the reaction was sent;
   * `live` is false when it was parked behind the initial sync.
   */
  reactionActivity: {
    kind: 'react' | 'unreact';
    message: Message;
    actorId: string;
    emoji: string;
    at: number;
    live: boolean;
  };
  /** A message was deleted for everyone or expired: what announced it (a notification) no longer applies. */
  messageRemoved: { message: Message };
}

const RECEIPT_STATUS: Record<BackendEvents['receipt']['type'], MessageStatus> = {
  delivered: 'delivered',
  read: 'read',
  viewed: 'read',
};

/** How many purged message ids are remembered to suppress re-delivery. */
const PURGED_TOMBSTONES = 2_000;

/** How long `stop()` waits for post-connect steps that are still running. */
const POST_READY_STOP_WAIT_MS = 2_000;

const log = createLogger('sync');

/**
 * Error kinds that mean "an expected first-run/setup state", not a real
 * failure: the UI routes to its own screen for each of these (link flow,
 * account prompt, install prompt, unlock screen) rather than showing an
 * error. Logged once, at info — not at error, and not from every place that
 * happens to observe the same rejection (see `wasConnectionErrorReported`).
 */
const SETUP_STATE_MESSAGES: Partial<Record<ErrorKind, string>> = {
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
  private readonly reactionWatch: ReactionWatch;
  private readonly readState: ReadStateService;
  private readonly phonePrivacy: PhonePrivacyService;
  private readonly profile: ProfileService;
  private readonly onError: ErrorReporter;
  private unsubscribers: Unsubscribe[] = [];
  /**
   * The second of two serial queues in series (the first is the backend
   * adapter's; see the ordering contract at `SignalCliBackend.enqueue`). It
   * applies what the adapter emitted, in the order emitted, and a `checkpoint`
   * is acknowledged only after everything before it is stored. Nothing that
   * waits on the network runs in it: read receipts go out behind it
   * (see ReadStateService), so a slow call never holds later events. Ephemeral events
   * (`status`, `typing`, `catchingUp`, `contactUpdated`, ...) skip it.
   */
  private queue: Promise<void> = Promise.resolve();
  /** The connect attempt in flight, if any; callers join it rather than starting a second. */
  private startPromise: Promise<void> | null = null;
  /**
   * True from the first successful connect until `stop()`. From then on a
   * `start()` while the connection is down reconnects the backend (the Retry
   * buttons and the retry timer) instead of repeating the initial sync.
   */
  private connected = false;
  /**
   * The `after-ready` post-connect steps, running in the background: a
   * connect is done once the session is ready, so Retry and startup never
   * wait on a plugin's start, and `stop()` never waits long for one.
   */
  private postReady: Promise<void> | null = null;
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
   * start and `caughtUp`, that differs in its ceiling and, when the backend
   * orders its `catchingUp` signal, in having no quiet period: it drives
   * `session.notificationsHeld`, which can outlast the sidebar's
   * `catchingUp` (see `startCatchUp`).
   */
  private readonly notificationHold: CatchUpTracker;
  /**
   * Bumped by every `startCatchUp`. A `caughtUp` is stamped with it when it
   * arrives, because it is queued behind the messages before it and runs
   * later; if a newer catch-up started in between, it belongs to the old one
   * and must not end the new one.
   */
  private catchUpEpoch = 0;
  /** The newest catch-up number the backend has announced (see `CatchUpMark`). */
  private backendCatchUpSeq = 0;
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
    this.reactionWatch = deps.reactionWatch ?? new ReactionWatch();
    this.onError = deps.onError ?? consoleReporter;
    this.readState =
      deps.readState ??
      new ReadStateService({
        backend: deps.backend,
        repository: deps.repository,
        stores: deps.stores,
        clock: deps.clock,
        scheduler: deps.scheduler,
        schedulePurge: (delayMs) => {
          this.schedulePurge(delayMs);
        },
        onError: this.onError,
      });
    this.phonePrivacy =
      deps.phonePrivacy ??
      new PhonePrivacyService({
        backend: deps.backend,
        stores: deps.stores,
        scheduler: deps.scheduler,
        readState: this.readState,
        onError: this.onError,
      });
    this.profile =
      deps.profile ??
      new ProfileService({ backend: deps.backend, stores: deps.stores, onError: this.onError });
    this.catchUpTracker = new CatchUpTracker({
      clock: deps.clock,
      scheduler: deps.scheduler,
      isBusy: () => this.hasPendingEvents(),
      onChange: (catchingUp) => {
        this.deps.stores.session.getState().setCatchingUp(catchingUp);
      },
    });
    this.notificationHold = new CatchUpTracker({
      clock: deps.clock,
      scheduler: deps.scheduler,
      isBusy: () => this.hasPendingEvents(),
      onChange: (held) => {
        this.deps.stores.session.getState().setNotificationsHeld(held);
      },
      // Counts and reasons only, so a report of notifications arriving on wake
      // can be told apart from the log: which kind of hold, how it ended.
      onStart: ({ strict, restarted }) => {
        log.info('notification hold started', { strict, restarted });
      },
      onEnd: (reason, { strict, messages }) => {
        const detail = { reason, strict, messages };
        if (
          reason === 'ceiling' &&
          this.deps.backend.capabilities.features.has('catchingUpSignal')
        ) {
          // This backend promises a `caughtUp`; hitting the ceiling means it never came.
          log.warn('notification hold ended by its ceiling before caughtUp', detail);
        } else {
          log.info('notification hold ended', detail);
        }
      },
    });
  }

  /**
   * Connects (or reconnects) and, the first time, performs the initial sync.
   * Safe to call repeatedly: a call while a connect is in flight joins it, one
   * while the connection is healthy does nothing, and one after a dropped or
   * failed connection (the Retry buttons, the retry timer) reconnects.
   */
  start(): Promise<void> {
    if (this.startPromise) return this.startPromise;
    if (this.connected) {
      const { link } = this.deps.stores.session.getState();
      if (link !== 'error' && link !== 'offline') return Promise.resolve();
    }
    const attempt: Promise<void> = (this.connected ? this.doReconnect() : this.doStart()).finally(
      () => {
        if (this.startPromise === attempt) this.startPromise = null;
      },
    );
    this.startPromise = attempt;
    return attempt;
  }

  private async doStart(): Promise<void> {
    const { backend, stores } = this.deps;
    // A fresh attempt (manual or the steady-state retry below) supersedes
    // any retry still pending from an earlier failure.
    this.accountRetryCancel?.();
    this.accountRetryCancel = null;
    stores.session.getState().setBackendKind(backend.kind);
    stores.session.getState().markConnecting();
    this.gated = true;
    this.subscribe();
    // "Catching up" from here; `subscribe()` wired the events that end it.
    this.startCatchUp();
    // Until the connected daemon has been asked, nothing that depends on the
    // phone's privacy settings (read receipts, typing, link previews) may go
    // out. `PhonePrivacyService.refresh` settles this right after `connect()`.
    stores.session.getState().setPhonePrivacy({ status: 'pending', values: UNKNOWN_PHONE_PRIVACY });
    try {
      await backend.connect();
      this.restartHoldForConnectedBackend();
      await this.phonePrivacy.refresh();
      await this.initialSync();
    } catch (error) {
      // Drop the subscriptions so a retry doesn't double-subscribe, but keep the
      // backlog: those envelopes are gone from the daemon once delivered.
      this.unsubscribeAll();
      this.disposeCatchUp();
      this.failConnect(error, 'initial sync failed');
      throw error;
    }
    this.connected = true;
    // Before the gate opens: nothing live can have been let through yet, so
    // whatever listens for it (notifications) is ready for the first one.
    await this.deps.postConnect?.run('before-live');
    stores.session.getState().markSynced();
    this.openGate();
    this.armCatchUpQuiet();
    this.schedulePurge(0);
    this.runPostReady();
  }

  /**
   * Reconnects after the connection dropped or the last attempt failed, once
   * the initial sync has already succeeded: the subscriptions and the gate
   * stay as they are. When the backend's stream gave up (`error`) it starts
   * over, so this does what its offline-to-online step would: catch up again
   * and read the phone's settings again. When the stream is only waiting to
   * retry (`offline`), `connect()` makes it retry now, and the backend's
   * status events do the rest.
   */
  private async doReconnect(): Promise<void> {
    const { backend, stores } = this.deps;
    const startedOver = stores.session.getState().link === 'error';
    this.accountRetryCancel?.();
    this.accountRetryCancel = null;
    if (startedOver) this.startCatchUp();
    try {
      await backend.connect();
      if (startedOver) {
        this.restartHoldForConnectedBackend();
        await this.phonePrivacy.refresh();
        this.armCatchUpQuiet();
        // The stream's own `open` may still be on its way; don't leave the
        // banner on the old error until it arrives.
        stores.session.getState().setLink(backend.getStatus());
      }
    } catch (error) {
      if (startedOver) this.disposeCatchUp();
      this.failConnect(error, 'reconnect failed');
      throw error;
    }
    await this.deps.postConnect?.run('before-live');
    this.runPostReady();
  }

  /** Starts the `after-ready` steps in the background, unless a run is already going. */
  private runPostReady(): void {
    const { postConnect } = this.deps;
    if (!postConnect || this.postReady) return;
    const run: Promise<void> = postConnect
      .run('after-ready')
      .catch((error: unknown) => {
        this.onError(error, 'post-connect steps failed');
      })
      .finally(() => {
        if (this.postReady === run) this.postReady = null;
      });
    this.postReady = run;
  }

  /** Resolves once the post-connect steps that follow a connect have finished (tests, startup). */
  settled(): Promise<void> {
    return this.postReady ?? Promise.resolve();
  }

  /** Records a failed connect in the session store and logs it, once. */
  private failConnect(error: unknown, context: string): void {
    const { stores } = this.deps;
    const appError = toAppError(error);
    stores.session.getState().markFailed(appError);
    // The single place this failure is logged (see `wasConnectionErrorReported`):
    // an expected setup state (no account yet, signal-cli not installed, …)
    // is routed to its own screen and logged once at info, not at error;
    // a real failure still logs once, at error, never from the other
    // places (App.tsx, ConnectionBanner) that also observe this rejection.
    const setupMessage = SETUP_STATE_MESSAGES[appError.kind];
    if (setupMessage !== undefined) log.info(setupMessage);
    else this.onError(error, context);
    markConnectionErrorReported(error);
    // The backend already backed off restarting signal-cli a few times
    // (see SignalCliBackend's `resolveAccount`); keep that going at a
    // slower, steady pace rather than leaving it to a manual Retry click —
    // this must never happen for `no-account`/`account-required`, which
    // mean the user has to act (link, or enter an account number).
    if (appError.kind === 'account-unavailable') {
      this.accountRetryCancel = this.deps.scheduler.setTimeout(() => {
        this.accountRetryCancel = null;
        this.start().catch(
          ignored('an automatic retry’s failure is already reported by the connect itself'),
        );
      }, ACCOUNT_UNAVAILABLE_RETRY_MS);
    }
  }

  /**
   * Begins "catching up": the sidebar freeze, and the hold on notifications.
   * Both end together on `caughtUp` or the quiet period; they differ in the
   * ceiling. The sidebar's stays short so the UI never looks stuck. The
   * hold's is much longer when the backend is known to send `caughtUp`
   * (the `catchingUpSignal` feature), because then the ceiling is only a safety
   * net and a backlog still draining when it fires would all notify; without
   * that signal it is the same short one, so older builds behave as before.
   *
   * `ordered` is for a run started by the backend's own `catchingUp` when the
   * backend orders it before every message of the connection
   * (the `orderedCatchingUp` feature). The quiet period only ever covered a
   * `catchingUp` that could arrive late, and silence right after a wake is not
   * an end (network and server coming back, timers running late), so that
   * hold ends on `caughtUp` or the ceiling alone.
   */
  private startCatchUp(ordered = false): void {
    this.catchUpEpoch += 1;
    this.catchUpTracker.start();
    this.notificationHold.start(
      this.deps.backend.capabilities.features.has('catchingUpSignal')
        ? NOTIFICATION_HOLD_CEILING_MS
        : undefined,
      { strict: ordered },
    );
  }

  /**
   * The hold begun at the top of `doStart` was sized before the backend had
   * been asked for its version, so a build that sends `caughtUp` was treated
   * as one that doesn't: the short ceiling and a quiet period instead of the
   * long ceiling and `caughtUp` alone. Its own `catchingUp` can't fix that, as
   * events are ignored during the initial sync. Once connected, begin the hold
   * again the way `catchingUp` would have. Nothing is released early: the new
   * run only ever lasts longer, and a `caughtUp` already parked is still
   * applied when the gate opens (the epoch is unchanged).
   */
  private restartHoldForConnectedBackend(): void {
    const { backend } = this.deps;
    if (!backend.capabilities.features.has('catchingUpSignal')) return;
    this.notificationHold.start(NOTIFICATION_HOLD_CEILING_MS, {
      strict: backend.capabilities.features.has('orderedCatchingUp'),
    });
  }

  private armCatchUpQuiet(): void {
    this.catchUpTracker.armQuiet();
    this.notificationHold.armQuiet();
  }

  private disposeCatchUp(): void {
    this.catchUpTracker.dispose();
    this.notificationHold.dispose();
    // The trackers stop without notifying, so the flags they last set would
    // otherwise stay on (a sidebar stuck on "Loading…" after a failed start).
    const session = this.deps.stores.session.getState();
    session.setCatchingUp(false);
    session.setNotificationsHeld(false);
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
    this.queued++;
    this.queue = this.queue.then(() => {
      if (generation === this.generation) return this.run(event, task, true);
      this.queued--;
      return undefined;
    });
  }

  /** Tasks waiting in (or running in) this queue. */
  private queued = 0;

  /** Whether events are still waiting in this queue or in the backend's own. */
  private hasPendingEvents(): boolean {
    return this.queued > 0 || this.deps.backend.hasPendingEvents();
  }

  private unsubscribeAll(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  async stop(): Promise<void> {
    if (this.startPromise)
      await this.startPromise.catch(
        ignored('stop only waits for the start to settle; its failure went to its caller'),
      );
    this.accountRetryCancel?.();
    this.accountRetryCancel = null;
    this.phonePrivacy.cancelRetry();
    this.pruneTimer?.();
    this.purgeTimer?.();
    this.pruneTimer = null;
    this.purgeTimer = null;
    this.disposeCatchUp();
    // Steps due again after a reconnect; one still running stops after its
    // current step, and a step that hangs is only waited for briefly.
    this.deps.postConnect?.reset();
    await this.waitForPostReady();
    await this.idle();
    // A read receipt still in flight goes out before the connection is closed,
    // but a hung one is only waited for briefly.
    await this.readState.waitForReceipts();
    // Disconnect while still subscribed so the final "offline" status reaches the store.
    await this.deps.backend.disconnect();
    this.teardown();
    this.startPromise = null;
    this.connected = false;
    this.deps.stores.session.getState().markStopped();
  }

  private async waitForPostReady(): Promise<void> {
    const running = this.postReady;
    if (!running) return;
    let cancel: Cancel | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      cancel = this.deps.scheduler.setTimeout(resolve, POST_READY_STOP_WAIT_MS);
    });
    await Promise.race([running, gaveUp]);
    cancel?.();
    this.postReady = null;
  }

  private teardown(): void {
    this.generation++;
    this.unsubscribeAll();
    this.queue = Promise.resolve();
    this.readState.teardown();
    this.backlog = [];
    this.gated = true;
    this.parkedReactions = [];
    this.phonePrivacy.teardown();
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

  /**
   * Stores a contact, and the user's own profile when it is theirs. The initial
   * sync answers from what it has after a bounded wait on the contact listing,
   * so the real profile can arrive after `getSelf` gave a placeholder; a photo
   * set this session is kept.
   */
  private applyContact(contact: Contact): void {
    const { stores } = this.deps;
    stores.contacts.getState().upsert(contact);
    const self = stores.session.getState().self;
    if (self && contact.id === self.id) {
      const avatarUrl = self.avatarUrl;
      stores.session
        .getState()
        .setSelf({ ...contact, isSelf: true, ...(avatarUrl ? { avatarUrl } : {}) });
    }
  }

  /** Contacts announced while the initial sync was loading (see `contactsSeenDuringSync`). */
  private contactsSeenDuringSync: Map<string, Contact> | null = null;

  private async initialSync(): Promise<void> {
    this.contactsSeenDuringSync = new Map();
    try {
      await this.runInitialSync();
    } finally {
      this.contactsSeenDuringSync = null;
    }
  }

  private async runInitialSync(): Promise<void> {
    const { backend, repository, stores } = this.deps;
    const [self, contacts, listedByBackend] = await Promise.all([
      backend.getSelf(),
      backend.listContacts(),
      backend.listConversations(),
    ]);
    const conversations = this.admit(listedByBackend);
    stores.session.getState().setSelf(self);
    stores.contacts.getState().upsertMany([self, ...contacts]);
    // Anything announced while those answers were being built is newer.
    for (const contact of this.contactsSeenDuringSync?.values() ?? []) this.applyContact(contact);
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
    await Promise.all(listed.map((c) => this.readState.recomputeUnread(c.id)));
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
    if (!backend.capabilities.features.has('historyArchive')) return;
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
              const wrote = await backend.historyHasOutgoing(c.id);
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
      backend.capabilities.features.has('history') &&
      !isDeletedRequest(stores, conv.id) &&
      (await repository.count(conv.id)) === 0
    ) {
      // Imported history only enriches a chat: when it can't be read, the chat
      // starts without it instead of failing the whole initial sync.
      const page = await backend
        .fetchHistory(conv.id, { limit: this.deps.seedPageSize ?? 50 })
        .catch((error: unknown) => {
          log.warn('history unavailable for a chat', { reason: toAppError(error).kind });
          const none: { messages: Message[]; hasMoreBefore: boolean; readUpTo?: number } = {
            messages: [],
            hasMoreBefore: false,
          };
          return none;
        });
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

  // ─── Read state ────────────────────────────────────────────────────────

  /** Recover a server-committed read whose local write was interrupted. */
  private async recoverHistoryTimers(): Promise<void> {
    const { backend, repository, stores, clock } = this.deps;
    if (!backend.capabilities.features.has('historyArchive')) return;
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
          await refreshPreviewAfterRemoval(
            stores.conversations,
            repository,
            message.conversationId,
            message,
          );
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
    if (!backend.capabilities.features.has('historyArchive')) return;
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
          await refreshPreviewAfterRemoval(
            stores.conversations,
            repository,
            conversationId,
            current,
          );
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
   * Marks everything in a conversation as read (see {@link ReadStateService}).
   * Kept here for the UI and plugin host, which reach it through the sync service.
   */
  markConversationRead(conversationId: ConversationId): Promise<void> {
    return this.readState.markConversationRead(conversationId);
  }

  /** Read receipts for a conversation just accepted (see {@link ReadStateService}). */
  sendHeldReadReceipts(conversationId: ConversationId): Promise<void> {
    return this.readState.sendHeldReadReceipts(conversationId);
  }

  // ─── Phone privacy settings and profile ───────────────────────────────

  /** Settings → Privacy (see {@link PhonePrivacyService.update}). */
  updatePhonePrivacy(patch: PhonePrivacyPatch): Promise<boolean> {
    return this.phonePrivacy.update(patch);
  }

  /** Settings → Profile (see {@link ProfileService.update}). */
  updateProfile(update: ProfileUpdate): Promise<string | null> {
    return this.profile.update(update);
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
        if (status === 'online' && this.deps.stores.session.getState().link === 'offline') {
          // Our own stream dropped, which says nothing about whether signal-cli
          // reconnected too. If its `catchingUp` already started a strict hold,
          // keep it: restarting would bring back a quiet period that could end
          // it before the backlog. If it comes after, it restarts the hold strictly.
          if (!this.notificationHold.isStrict) {
            this.startCatchUp();
            this.armCatchUpQuiet();
          }
          // The daemon may have restarted: read the phone's settings again.
          void this.phonePrivacy.refresh();
        }
        this.deps.stores.session.getState().setLink(status);
      },
      true,
    );
    // The phone's privacy settings changed (patches/signal-cli 0018). Ephemeral:
    // applied at once, never parked behind the initial sync.
    on(
      'phonePrivacyChanged',
      () => {
        void this.phonePrivacy.refresh();
      },
      true,
    );
    // Held read receipts leave (or are dropped) the moment the settings are known.
    this.unsubscribers.push(this.phonePrivacy.watch());
    // signal-cli reconnected to the server by itself (after a sleep or a network
    // change; our own stream never dropped) and is draining what queued up
    // (patches/signal-cli 0020, build 21+): catch up again, like after an offline period.
    // Applied at once, not queued: behind a message backlog it would come too
    // late to cover those messages. During the initial sync the trackers are
    // already catching up and the quiet period must not start yet, so it is
    // ignored there.
    on(
      'catchingUp',
      (mark) => {
        if (mark) this.backendCatchUpSeq = mark.seq;
        if (this.gated) return;
        this.startCatchUp(backend.capabilities.features.has('orderedCatchingUp'));
        this.armCatchUpQuiet();
      },
      true,
    );
    // Queued (and parked behind the initial sync) like messages, so catch-up
    // ends only once every message before it has reached the stores. It is
    // stamped on arrival (see `catchUpEpoch`): one that was already waiting
    // when a newer catch-up began belongs to the one before.
    this.unsubscribers.push(
      backend.on('caughtUp', (mark) => {
        const epoch = this.catchUpEpoch;
        // Numbered by the backend when the signal arrived there: the backend
        // emits it behind its own queue, so a newer catch-up may have begun
        // by now even though the epoch above is current.
        const stale = mark !== undefined && mark.seq < this.backendCatchUpSeq;
        const end = (): void => {
          if (stale || epoch !== this.catchUpEpoch) {
            log.info('ignored a caughtUp that belongs to an earlier catch-up');
            return;
          }
          this.catchUpTracker.finish();
          this.notificationHold.finish();
        };
        if (this.gated) this.backlog.push({ event: 'caughtUp', task: end });
        else this.enqueue('caughtUp', end);
      }),
    );
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
        // During the initial sync the answers it is about to store may be
        // older than this: remember the newest per contact and re-apply after.
        this.contactsSeenDuringSync?.set(contact.id, contact);
        this.applyContact(contact);
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
        // Like Desktop, an edit that reaches the server more than two days after the
        // message is dropped (the user's own note-to-self is exempt).
        e.serverAt !== undefined && isTooOldToEdit(m, e.serverAt, this.selfId() ?? null)
          ? m
          : applyEdit(m, {
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
    on('reaction', (e, live) => this.onReaction(e, live));
    on('pollVote', (e, live) => this.onPollVote(e, live));
    on('pollTerminate', (e, live) => this.onPollTerminate(e, live));
    on('receipt', (e) => this.onReceipt(e));
    on('readSync', (e) => this.readState.applyReadSync(e));
    // Queued like everything else (and parked behind the initial-sync gate),
    // so the transport only learns a position once everything before it has
    // been written to the repository. A lost ack just means re-delivery.
    on('checkpoint', (e) => {
      this.deps.backend.acknowledge(e.cursor);
    });
  }

  private async run(
    event: string,
    fn: () => Promise<void> | void,
    /** Came from the queue: counts down `queued` when done. */
    queued = false,
  ): Promise<void> {
    try {
      await fn();
    } catch (error) {
      // One bad event must not stall the queue.
      this.onError(error, `sync: ${event} handler failed`);
    } finally {
      if (queued) this.queued--;
    }
  }

  private async onMessage(incoming: Message, live: boolean): Promise<void> {
    // A message processed (not merely arrived) means the backlog is still
    // flowing: the quiet period is measured on the same step that decides
    // whether it notifies (`messageArrived` is emitted at the end of this
    // method), so it cannot end while stored-but-unprocessed messages are
    // still queued behind it.
    try {
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
      // Only a real message does: a system line (a decrypt failure, a changed
      // safety number, a timer change) from them never brings the chat back.
      if (incoming.authorId !== this.selfId() && incoming.kind === 'normal')
        stores.local.getState().clearDeleted(incoming.conversationId);
      // A burst of held-back messages from someone whose key changed brings one
      // "Safety Number … has changed" line, not one each: skip it while the last
      // line in the chat is already that one.
      if (incoming.systemAction?.kind === 'safety-number') {
        // The key behind a verified badge just changed.
        stores.identities.getState().setTrust(incoming.systemAction.contactId, 'untrusted');
        if (this.repeatsLastLine(incoming)) return;
      }
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
      this.readState.noteArrival(message);
      // A re-delivery must not count twice or re-notify plugins.
      if (!created) return;
      // New activity brings an archived chat back to the list, like Signal Desktop
      // (it does so for a muted one too, unless "keep muted chats archived" is on).
      if (message.kind === 'normal') stores.local.getState().unarchive(id);
      await this.updateReadState(message);
      this.events.emit('message', message);
      this.events.emit('messageArrived', { message, live });
      if (this.parkedReactions.length > 0 && message.authorId === this.selfId())
        await this.replayParkedReactions(message, live);
    } finally {
      this.catchUpTracker.onMessage();
      this.notificationHold.onMessage();
    }
  }

  /** Whether the newest loaded message is a system line with the same button for the same person. */
  private repeatsLastLine(line: Message): boolean {
    const window = this.deps.stores.messages.getState().windows[line.conversationId];
    const lastId = window?.anchoredToPresent ? window.ids[window.ids.length - 1] : undefined;
    const last = lastId === undefined ? undefined : window?.byId[lastId];
    return (
      last?.kind === 'system' &&
      last.systemAction?.kind === line.systemAction?.kind &&
      last.systemAction?.contactId === line.systemAction?.contactId
    );
  }

  private async updateReadState(message: Message): Promise<void> {
    const { stores } = this.deps;
    const id = message.conversationId;
    const selfId = this.selfId();
    if (!selfId || message.seq === undefined) return;
    if (message.authorId === selfId) {
      // Sent from another of our devices: we've evidently read up to here.
      await this.readState.noteOwnMessage({
        conversationId: id,
        seq: message.seq,
        sentAt: message.sentAt,
      });
    } else if (this.isViewing(id)) {
      // The receipt is a network call: it runs behind the queue, never in it.
      await this.readState.markReadLocally(id);
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
   * A reaction. Someone else's reaction to a message of the user's own is
   * news, as on Signal Desktop: it is kept unread until the chat is read (and
   * the user's other devices are told, so the phone drops its notification),
   * and announced (`reactionActivity`). Reading it at once when the user is
   * looking at the chat is what stops the phone from announcing it at all.
   */
  private async onReaction(e: BackendEvents['reaction'], live: boolean): Promise<void> {
    const id = messageId(e.targetAuthorId, e.targetSentAt);
    if (e.remove) this.reactionWatch.noteRemoved(id, e.reaction.authorId);
    const before = await this.deps.repository.get(id);
    await this.updateMessage(e.conversationId, id, (m) => ({
      ...m,
      reactions: applyReaction(m.reactions, e.reaction, e.remove),
    }));
    const selfId = this.selfId();
    const actorId = e.reaction.authorId;
    if (!before) {
      // Not stored yet: the reaction was parked; it counts once its target turns up.
      if (selfId !== undefined && e.targetAuthorId === selfId && actorId !== selfId)
        this.parkReaction(id, e, live);
      return;
    }
    if (
      selfId === undefined ||
      before.authorId !== selfId ||
      before.conversationId !== e.conversationId ||
      before.deleted ||
      actorId === selfId
    )
      return;
    const previous = before.reactions.find((r) => r.authorId === actorId);
    const message = (await this.deps.repository.get(id)) ?? before;
    const base = { message, actorId, emoji: e.reaction.emoji, at: e.reaction.at, live };
    if (e.remove) {
      // Taking back what was never there (or already replaced) changes nothing.
      if (previous?.emoji !== e.reaction.emoji) return;
      // Nothing left to read for that message: no sync for it later.
      if (!hasOthersActivity(message, selfId))
        this.deps.stores.local.getState().dropUnreadActivity(message.sentAt);
      this.events.emit('reactionActivity', { kind: 'unreact', ...base });
      return;
    }
    // The same reaction again (a re-delivery) is not news.
    if (previous?.emoji === e.reaction.emoji) return;
    await this.noteActivity(before);
    this.events.emit('reactionActivity', { kind: 'react', ...base });
  }

  /** Reactions to the user's messages that beat the message (see `replayParkedReactions`). */
  private parkedReactions: {
    id: MessageId;
    e: BackendEvents['reaction'];
    live: boolean;
    at: number;
  }[] = [];

  private parkReaction(id: MessageId, e: BackendEvents['reaction'], live: boolean): void {
    const now = this.deps.clock.now();
    this.parkedReactions = this.parkedReactions.filter((p) => now - p.at <= PENDING_OPS_TTL_MS);
    this.parkedReactions.push({ id, e, live, at: now });
    if (this.parkedReactions.length > PENDING_OPS_MAX) this.parkedReactions.shift();
  }

  /**
   * The message a reaction was waiting for has arrived (the parked reaction is
   * already applied to it): count it as news like a reaction that came after,
   * unless it has since been taken back or replaced, or has gone stale.
   */
  private async replayParkedReactions(message: Message, live: boolean): Promise<void> {
    const now = this.deps.clock.now();
    this.parkedReactions = this.parkedReactions.filter((p) => now - p.at <= PENDING_OPS_TTL_MS);
    const mine = this.parkedReactions.filter((p) => p.id === message.id);
    if (mine.length === 0) return;
    this.parkedReactions = this.parkedReactions.filter((p) => p.id !== message.id);
    // Each person's last word.
    const last = new Map<string, (typeof mine)[number]>();
    for (const p of mine) last.set(p.e.reaction.authorId, p);
    for (const { e, live: parkedLive } of last.values()) {
      const actorId = e.reaction.authorId;
      if (
        e.remove ||
        e.conversationId !== message.conversationId ||
        !message.reactions.some((r) => r.authorId === actorId && r.emoji === e.reaction.emoji)
      )
        continue;
      await this.noteActivity(message);
      this.events.emit('reactionActivity', {
        kind: 'react',
        message,
        actorId,
        emoji: e.reaction.emoji,
        at: e.reaction.at,
        live: live && parkedLive,
      });
    }
  }

  /**
   * Records an unseen reaction or vote on one of the user's messages, and
   * reads it straight away while the user is looking at the chat.
   */
  private async noteActivity(target: Message): Promise<void> {
    const id = target.conversationId;
    this.deps.stores.local.getState().noteUnreadActivity(id, target.sentAt);
    if (this.isViewing(id)) await this.readState.markReadLocally(id);
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
      if (message) {
        await this.noteActivity(before);
        this.events.emit('pollActivity', { kind: 'vote', message, actorId: e.voterId, live });
      }
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
    this.announceRemoved(before);
  }

  /**
   * A message is gone (deleted for everyone, or expired): whatever was said
   * about it stops applying: its unread reactions and votes, and a
   * notification that quotes it (`messageRemoved`).
   */
  private announceRemoved(message: Message): void {
    if (message.authorId === this.selfId())
      this.deps.stores.local.getState().dropUnreadActivity(message.sentAt);
    this.events.emit('messageRemoved', { message });
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
    // Not while stopped (`stop()` cancels the timer); a connect that has
    // finished is no reason to stop purging.
    if (!this.connected) return;
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

  /** Purges at `at` (epoch ms) a message whose timer was set outside this service (one just sent). */
  noteExpiry(at: number): void {
    this.schedulePurge(at - this.deps.clock.now());
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
      await refreshPreviewAfterRemoval(stores.conversations, repository, m.conversationId, m);
      this.announceRemoved(m);
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
}

/** Whether anyone else's reaction or vote is still on the user's message. */
function hasOthersActivity(message: Message, selfId: string): boolean {
  return (
    message.reactions.some((r) => r.authorId !== selfId) ||
    (message.poll?.votes.some((v) => v.voterId !== selfId && v.optionIndexes.length > 0) ?? false)
  );
}
