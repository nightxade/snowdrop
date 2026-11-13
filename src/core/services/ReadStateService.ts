/**
 * Read state: what the user has read, and telling Signal about it.
 *
 * Owns marking a conversation read (cursor, badge, disappearing-message
 * countdowns), the read receipts and read syncs that follow (sent, or held
 * while the phone's privacy settings are unknown), what a read on another
 * device does here, and the unread recount.
 *
 * SyncService stays the event queue and router: it calls in here at the same
 * points it handled these events before, so whatever ran inside its queue
 * still does. A receipt is a network call and never runs in the queue; it goes
 * out one at a time behind it (`receiptTail`).
 */
import type { BackendEvents, ChatBackend, MessageRef } from '@/core/backend';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { createLogger, ignored, type Cancel, type Clock, type Scheduler } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import {
  computeUnread,
  effectivePrivacy,
  selectMessageRequestState,
  type Stores,
} from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface ReadStateServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  scheduler: Scheduler;
  /** Purge expired messages after this many ms (a countdown just started). */
  schedulePurge: (delayMs: number) => void;
  onError?: ErrorReporter;
}

/** How long `waitForReceipts` waits for a receipt that is still in flight. */
const RECEIPT_STOP_WAIT_MS = 2_000;

const log = createLogger('sync');

export class ReadStateService {
  private readonly onError: ErrorReporter;
  /** Bumped on teardown; receipt work from an older generation is dropped. */
  private generation = 0;
  /** Read receipts in flight, one at a time (see `sendReceiptsInOrder`); not part of SyncService's queue. */
  private receiptTail: Promise<void> = Promise.resolve();
  /** Read receipts earned while the phone's settings were still unknown; sent or dropped once they're known. */
  private heldReceipts: {
    conversationId: ConversationId;
    messages: MessageRef[];
    accepted: boolean;
    syncWithoutReceipt: boolean;
  }[] = [];
  /**
   * Conversations that may hold a message from someone else whose countdown
   * waits for a read, so a read position that moves (the phone read, the user
   * replied from another device) only looks when there is something to start.
   */
  private readonly timersWaiting = new Set<ConversationId>();
  /** Unread activity whose sync is on its way (`${conversation}\0${sentAt}`). */
  private readonly activityInFlight = new Set<string>();

  constructor(private readonly deps: ReadStateServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  private selfId(): string | undefined {
    return this.deps.stores.session.getState().self?.id;
  }

  /** Forgets everything in flight (the session was stopped); older work stops mattering. */
  teardown(): void {
    this.generation++;
    this.receiptTail = Promise.resolve();
    this.heldReceipts = [];
    this.timersWaiting.clear();
    this.activityInFlight.clear();
  }

  /** Resolves once the receipts in flight went out, or after a short wait for a hung one. */
  async waitForReceipts(): Promise<void> {
    let cancel: Cancel | undefined;
    const gaveUp = new Promise<void>((resolve) => {
      cancel = this.deps.scheduler.setTimeout(resolve, RECEIPT_STOP_WAIT_MS);
    });
    await Promise.race([this.receiptTail, gaveUp]);
    cancel?.();
  }

  /** Recounts from the cursor; only reads unread messages, never the whole history. */
  async recomputeUnread(conversationId: ConversationId): Promise<void> {
    const { repository, stores } = this.deps;
    const selfId = this.selfId();
    if (!selfId) return;
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const after = await repository.listAfter(conversationId, cursor);
    if (after.some((m) => this.waitsForRead(m))) this.timersWaiting.add(conversationId);
    stores.conversations.getState().setUnread(conversationId, computeUnread(after, selfId, cursor));
  }

  /** A stored message: if its countdown waits for a read, the chat is noted as having one. */
  noteArrival(message: Message): void {
    if (this.waitsForRead(message)) this.timersWaiting.add(message.conversationId);
  }

  /**
   * Marks everything in a conversation as read: advances the cursor, clears
   * badges and (if enabled) sends read receipts for the newly read messages.
   */
  async markConversationRead(conversationId: ConversationId): Promise<void> {
    const { receipts } = await this.markReadLocally(conversationId);
    await receipts;
  }

  /**
   * The local half of {@link markConversationRead}: cursor, badge and
   * repository are settled when the returned promise resolves. The read
   * receipt / read sync (a network call) is started behind it and handed back
   * as `receipts`: the event queue never waits for it, the UI-facing
   * `markConversationRead` does.
   */
  async markReadLocally(conversationId: ConversationId): Promise<{ receipts?: Promise<void> }> {
    const { repository, stores } = this.deps;
    // A hand-set "unread" flag is local only and always ends here.
    stores.local.getState().setMarkedUnread(conversationId, false);
    const selfId = this.selfId();
    // Reactions and votes on the user's own messages are read with the chat
    // (Desktop's `getUnreadReactionsAndMarkRead`). They are not messages: they
    // never counted toward the badge, and each target needs its own read sync,
    // authored by the user, so the phone clears what it announced for it.
    // They stay recorded until the sync has gone out, so a failed one is tried again
    // the next time the chat is read.
    const activity = (stores.local.getState().unreadActivity[conversationId] ?? []).filter(
      (sentAt) => !this.activityInFlight.has(activityKey(conversationId, sentAt)),
    );
    const activitySync =
      selfId !== undefined && activity.length > 0
        ? this.sendActivityReadSync(
            conversationId,
            activity.map((sentAt) => ({ authorId: selfId, sentAt })),
          )
        : undefined;
    const done = (receipts?: Promise<void>): { receipts?: Promise<void> } => {
      const pending = [receipts, activitySync].filter((p) => p !== undefined);
      return pending.length === 0 ? {} : { receipts: Promise.all(pending).then(() => undefined) };
    };
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const unread = await repository.listAfter(conversationId, cursor);
    // Everything in this snapshot is about to be read; a later arrival is noted again.
    this.timersWaiting.delete(conversationId);
    const latest = unread.at(-1)?.seq;
    if (latest === undefined) {
      if (!activitySync) log.info('read sync skipped', { reason: 'no-unread' });
      stores.conversations.getState().setUnread(conversationId, { count: 0, mentions: 0 });
      return done();
    }
    // Only what was read comes off the badge: a message counted since this
    // snapshot (seq beyond `latest`) is still unread.
    const read = selfId ? computeUnread(unread, selfId, cursor) : undefined;
    if (!stores.conversations.getState().markRead(conversationId, latest, read)) {
      log.info('read sync skipped', { reason: 'already-read' });
      return done();
    }
    await repository.setReadCursor(conversationId, latest);
    // Reading is what starts the countdown of a disappearing message.
    if (unread.some((m) => this.waitsForRead(m))) await this.startReadTimers(unread);
    const toAck = unread.filter((m) => m.authorId !== selfId && m.kind === 'normal');
    if (toAck.length === 0) {
      log.info('read sync skipped', { reason: 'nothing-from-others' });
      return done();
    }
    // Reading is always synced to the user's own devices (that is what marks
    // it read on their phone). A message request is read without telling the
    // sender anything: its receipts go out only if the user accepts
    // (`sendHeldReadReceipts`).
    return done(
      this.sendReceiptsInOrder(
        conversationId,
        toAck.map((m) => ({ authorId: m.authorId, sentAt: m.sentAt })),
        selectMessageRequestState(stores, conversationId) === 'accepted',
      ),
    );
  }

  /**
   * The user's own message arrived from another of their devices: they've
   * evidently read up to its `seq`, and a countdown it passed starts now.
   */
  async noteOwnMessage(message: { conversationId: ConversationId; seq: number; sentAt: number }) {
    const { repository, stores } = this.deps;
    const id = message.conversationId;
    const before = stores.conversations.getState().readCursors[id] ?? 0;
    if (stores.conversations.getState().markRead(id, message.seq)) {
      await repository.setReadCursor(id, message.seq);
      if (this.timersWaiting.has(id))
        await this.startReadTimersBetween(id, before, message.seq, message.sentAt);
    }
  }

  /** Another device read: move the cursors forward, start what that passed, recount. */
  async applyReadSync(e: BackendEvents['readSync']): Promise<void> {
    const selfId = this.selfId();
    const latestByConv = new Map<ConversationId, number>();
    for (const ref of e.messages) {
      if (ref.authorId === selfId) {
        // The reactions or votes on one of the user's own messages were read on
        // another device. That says nothing about the messages around it, so the
        // read position stays; only what was waiting on that message is done.
        this.deps.stores.local.getState().dropUnreadActivity(ref.sentAt);
        continue;
      }
      const m = await this.deps.repository.get(messageId(ref.authorId, ref.sentAt));
      if (m?.seq === undefined) continue;
      latestByConv.set(m.conversationId, Math.max(latestByConv.get(m.conversationId) ?? 0, m.seq));
    }
    const conversations = this.deps.stores.conversations.getState();
    for (const [conv, seq] of latestByConv) {
      const before = conversations.readCursors[conv] ?? 0;
      if (before >= seq) continue;
      conversations.setReadCursors({ [conv]: seq });
      await this.deps.repository.setReadCursor(conv, seq);
      // Read on the phone: the countdown of what it passed starts now.
      if (this.timersWaiting.has(conv))
        await this.startReadTimersBetween(conv, before, seq, e.readAt);
      await this.recomputeUnread(conv);
    }
  }

  /** A disappearing message from someone else that nobody has read yet. */
  private waitsForRead(message: Message): boolean {
    return (
      message.authorId !== this.selfId() &&
      message.expiresAfterReadMs !== undefined &&
      message.expiresAt === undefined &&
      // (An imported copy merged into a live one counts too: its archive deadline
      // only ever shortens this one, see `readHistoryMessages`.)
      !message.deleted
    );
  }

  /**
   * Starts the countdown of the disappearing messages among `messages` that
   * the user has just read: from now, as Signal does. A message from someone
   * else carries only how long it lasts (`expiresAfterReadMs`) until then;
   * the user's own is already running.
   */
  private async startReadTimers(messages: readonly Message[], readAt?: number): Promise<void> {
    const { repository, stores, clock } = this.deps;
    const generation = this.generation;
    for (const m of messages.filter((message) => this.waitsForRead(message))) {
      const now = clock.now();
      // Read elsewhere earlier: it counts from then (never from the future), as on Desktop.
      const from = Math.min(readAt ?? now, now);
      const updated = await repository.update(m.id, (current) => {
        if (current.expiresAfterReadMs === undefined || current.expiresAt !== undefined)
          return current;
        const { expiresAfterReadMs, ...rest } = current;
        return { ...rest, expiresAt: from + expiresAfterReadMs };
      });
      if (generation !== this.generation) return;
      if (updated?.expiresAt === undefined) continue;
      stores.messages.getState().update(updated.conversationId, updated.id, () => updated);
      this.deps.schedulePurge(updated.expiresAt - now);
    }
  }

  /** Starts the countdowns of what the read position just passed: `(after, upTo]` in arrival order. */
  private async startReadTimersBetween(
    conversationId: ConversationId,
    after: number,
    upTo: number,
    readAt?: number,
  ): Promise<void> {
    const listed = await this.deps.repository.listAfter(conversationId, after);
    await this.startReadTimers(
      listed.filter((m) => m.seq !== undefined && m.seq <= upTo),
      readAt,
    );
    if (!listed.some((m) => (m.seq ?? 0) > upTo && this.waitsForRead(m)))
      this.timersWaiting.delete(conversationId);
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
    await this.sendReceiptsInOrder(
      conversationId,
      read.map((m) => ({ authorId: m.authorId, sentAt: m.sentAt })),
      true,
      false,
    );
  }

  /**
   * Decides the receipts held while the phone's privacy settings were unknown.
   * Called by whoever learns the settings (SyncService, today) the moment they
   * are no longer pending.
   */
  flushHeldReceipts(): void {
    const held = this.heldReceipts;
    this.heldReceipts = [];
    for (const { conversationId, messages, accepted, syncWithoutReceipt } of held) {
      void this.sendReadReceipts(conversationId, messages, accepted, syncWithoutReceipt);
    }
  }

  /**
   * Runs `sendReadReceipts` one call at a time, in the order asked, outside
   * the event queue. Order is the only thing receipts need (a later read of
   * the same chat must not overtake an earlier one); nothing in the queue
   * depends on their outcome, so a slow or hung `sendReceipt` only delays
   * later receipts, never an incoming message. Never rejects.
   */
  private sendReceiptsInOrder(
    conversationId: ConversationId,
    messages: MessageRef[],
    accepted: boolean,
    syncWithoutReceipt = true,
  ): Promise<void> {
    return this.inReceiptOrder(() =>
      this.sendReadReceipts(conversationId, messages, accepted, syncWithoutReceipt),
    );
  }

  /** Runs `job` after the receipts asked before it, unless the session was torn down meanwhile. */
  private inReceiptOrder(job: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    const run = this.receiptTail.then(() => (generation === this.generation ? job() : undefined));
    this.receiptTail = run.catch(
      ignored('a failed receipt job was already reported; the chain only keeps order'),
    );
    return run;
  }

  /**
   * Tells the user's own devices that the reactions and votes on these of
   * their messages were seen (`refs` are the user's own messages), so the
   * phone drops what it announced for them. Only ever a sync: nothing goes to
   * anyone else. A signal-cli that can't send one alone (the `readSync` feature)
   * would send a real receipt, so there it sends nothing, as before.
   */
  private sendActivityReadSync(conversationId: ConversationId, refs: MessageRef[]): Promise<void> {
    const keys = refs.map((ref) => activityKey(conversationId, ref.sentAt));
    for (const key of keys) this.activityInFlight.add(key);
    const forget = (): void => {
      const { local } = this.deps.stores;
      for (const ref of refs) local.getState().dropUnreadActivity(ref.sentAt);
    };
    return this.inReceiptOrder(async () => {
      const { backend } = this.deps;
      const generation = this.generation;
      if (!backend.capabilities.features.has('readSync')) {
        // Nothing can be sent: the unread record would only ever pile up.
        log.info('read sync skipped', { reason: 'unsupported', n: refs.length });
        forget();
        return;
      }
      try {
        const summary = await backend.markRead(conversationId, refs, { syncOnly: true });
        reportReadSync(refs.length, 'sync-only', summary);
        if (summary?.failure && generation === this.generation) {
          const { error, failed, of } = summary.failure;
          this.onError(error, `read sync failed (${failed} of ${of} recipients)`);
        }
        // Only a sync that reached the user's devices counts; anything else stays unread.
        if (readSyncReached(summary) && generation === this.generation) forget();
      } catch (error) {
        if (generation === this.generation) this.onError(error, 'read sync failed');
      }
    }).finally(() => {
      for (const key of keys) this.activityInFlight.delete(key);
    });
  }

  /**
   * Tells Signal these messages were read. A receipt to the senders goes out
   * only when the chat is `accepted` and the effective setting allows it: the
   * phone's when it has told us, Snowdrop's own otherwise. Otherwise, with a
   * signal-cli that can (the `readSync` feature), only the user's own devices are
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
    const generation = this.generation;
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
    if (!receipt && (!syncWithoutReceipt || !backend.capabilities.features.has('readSync'))) {
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
      reportReadSync(messages.length, receipt ? 'receipt' : 'sync-only', summary);
      // Some recipients' receipts failed outright: report it as a failed receipt, as when all do.
      if (summary?.failure && generation === this.generation) {
        const { error, failed, of } = summary.failure;
        this.onError(error, `read receipt failed (${failed} of ${of} recipients)`);
      }
    } catch (error) {
      // A receipt that fails because the session was torn down under it is not news.
      if (generation === this.generation) this.onError(error, 'read receipt failed');
    }
  }
}

function activityKey(conversationId: ConversationId, sentAt: number): string {
  return `${conversationId}\u0000${sentAt}`;
}

/** Whether a read sync reached the user's devices (a backend that can't say is trusted). */
function readSyncReached(summary: { sync: string } | undefined): boolean {
  return summary === undefined || ['success', 'none', 'unreported'].includes(summary.sync);
}

/**
 * Types and counts only. Anything but a success is shown at the default log
 * level: a read that clears here but stays unread on the phone has to leave a trace.
 */
function reportReadSync(
  n: number,
  mode: 'receipt' | 'sync-only',
  summary: { receipt: string; sync: string } | undefined,
): void {
  const fields = {
    n,
    mode,
    receipt: summary?.receipt ?? 'unreported',
    sync: summary?.sync ?? 'unreported',
  };
  const ok = (v: string) => v === 'success' || v === 'none' || v === 'unreported';
  if (ok(fields.receipt) && ok(fields.sync)) log.info('read sync sent', fields);
  else log.warn('read sync sent', fields);
}
