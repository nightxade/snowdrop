/**
 * The sync engine: backend events → repository + stores.
 *
 * Events are processed strictly in arrival order through a single queue, so
 * an edit can never overtake the message it edits even though persistence is
 * async. The UI only ever reads stores; it never subscribes to the backend.
 */
import type { BackendEvents, ChatBackend } from '@/core/backend';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyReaction,
  messageId,
  type Conversation,
  type ConversationId,
  type Message,
  type MessageId,
  type MessageStatus,
} from '@/core/domain';
import { Emitter, type Cancel, type Clock, type Scheduler, type Unsubscribe } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import { computeUnread, uiSelectors, type Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface SyncServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  scheduler: Scheduler;
  onError?: ErrorReporter;
  /** Newest messages copied from backend history per conversation on first sync. */
  seedPageSize?: number;
}

const RECEIPT_STATUS: Record<BackendEvents['receipt']['type'], MessageStatus> = {
  delivered: 'delivered',
  read: 'read',
  viewed: 'read',
};

export interface SyncEvents {
  /** A message (incoming or synced) after it has been persisted and applied to stores. */
  message: Message;
}

export class SyncService {
  private readonly events = new Emitter<SyncEvents>();
  private unsubscribers: Unsubscribe[] = [];
  private queue: Promise<void> = Promise.resolve();
  private pruneTimer: Cancel | null = null;
  private readonly onError: ErrorReporter;
  private refreshingConversations = false;

  constructor(private readonly deps: SyncServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Subscribes, connects, and performs the initial sync. */
  async start(): Promise<void> {
    const { backend, stores } = this.deps;
    stores.session.getState().setBackendKind(backend.kind);
    this.subscribe();
    try {
      await backend.connect();
      await this.initialSync();
      stores.session.getState().setReady(true);
    } catch (error) {
      stores.session.getState().setError(error instanceof Error ? error.message : String(error));
      stores.session.getState().setStatus('error');
      this.onError(error, 'initial sync failed');
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.pruneTimer?.();
    this.pruneTimer = null;
    await this.idle();
    // Disconnect while still subscribed so the final "offline" status reaches the store.
    await this.deps.backend.disconnect();
    for (const off of this.unsubscribers) off();
    this.unsubscribers = [];
  }

  /** Post-processing hooks (plugins, notifications) that should see stored state. */
  on<E extends keyof SyncEvents>(event: E, fn: (payload: SyncEvents[E]) => void): Unsubscribe {
    return this.events.on(event, fn);
  }

  /** Resolves once every queued event has been processed (tests, shutdown). */
  idle(): Promise<void> {
    return this.queue;
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

    const cursors = await repository.getReadCursors();
    await Promise.all(
      conversations.map(async (conv) => {
        const cursor = await this.seedConversation(conv, cursors.get(conv.id));
        if (cursor !== undefined) cursors.set(conv.id, cursor);
      }),
    );
    stores.conversations.getState().setReadCursors(Object.fromEntries(cursors));
    await Promise.all(conversations.map((c) => this.recomputeUnread(c.id)));
  }

  /**
   * Makes sure a conversation has local history and a read cursor.
   * Returns the cursor to use, or undefined to leave it unset.
   */
  private async seedConversation(
    conv: Conversation,
    storedCursor: number | undefined,
  ): Promise<number | undefined> {
    const { backend, repository, stores } = this.deps;
    let cursor = storedCursor;
    if (backend.fetchHistory && (await repository.count(conv.id)) === 0) {
      const page = await backend.fetchHistory(conv.id, { limit: this.deps.seedPageSize ?? 50 });
      await repository.putMany(page.messages);
      if (cursor === undefined && page.readUpTo !== undefined) {
        cursor = page.readUpTo;
        await repository.setReadCursor(conv.id, cursor);
      }
    }
    const [latest] = await repository.page(conv.id, { limit: 1 });
    if (latest) stores.conversations.getState().bumpActivity(conv.id, latest.sentAt);
    if (cursor === undefined) {
      // First sight of a conversation with no read info: treat existing history as read,
      // so connecting doesn't greet the user with hundreds of stale unread badges.
      cursor = latest?.sentAt ?? conv.lastActivityAt;
      await repository.setReadCursor(conv.id, cursor);
    }
    return cursor;
  }

  private async recomputeUnread(conversationId: ConversationId): Promise<void> {
    const { repository, stores } = this.deps;
    const selfId = stores.session.getState().self?.id;
    if (!selfId) return;
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const after = await repository.listAfter(conversationId, cursor);
    stores.conversations.getState().setUnread(conversationId, computeUnread(after, selfId, cursor));
  }

  // ─── Read state ────────────────────────────────────────────────────────

  /**
   * Marks everything in a conversation as read: advances the cursor, clears
   * badges and (if enabled) sends read receipts for the newly read messages.
   */
  async markConversationRead(conversationId: ConversationId): Promise<void> {
    const { repository, stores, backend } = this.deps;
    const selfId = stores.session.getState().self?.id;
    const cursor = stores.conversations.getState().readCursors[conversationId] ?? 0;
    const unread = await repository.listAfter(conversationId, cursor);
    const latest = unread.at(-1)?.sentAt;
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
    return ui.windowFocused && uiSelectors.selectedConversation(ui) === conversationId;
  }

  // ─── Events ────────────────────────────────────────────────────────────

  private subscribe(): void {
    const { backend } = this.deps;
    const on = <E extends keyof BackendEvents>(
      event: E,
      handler: (payload: BackendEvents[E]) => Promise<void> | void,
      sync = false,
    ): void => {
      this.unsubscribers.push(
        backend.on(event, (payload) => {
          if (sync) {
            void this.run(event, () => handler(payload));
            return;
          }
          this.queue = this.queue.then(() => this.run(event, () => handler(payload)));
        }),
      );
    };

    // Status is applied immediately (not queued) so the UI reflects it without delay.
    on(
      'status',
      (status) => {
        this.deps.stores.session.getState().setStatus(status);
      },
      true,
    );
    on('message', (m) => this.onMessage(m));
    on('messageEdited', (e) =>
      this.updateMessage(e.conversationId, messageId(e.authorId, e.targetSentAt), (m) =>
        applyEdit(m, { body: e.body, ranges: e.ranges, editedAt: e.editedAt }),
      ),
    );
    on('messageDeleted', async (e) => {
      await this.updateMessage(
        e.conversationId,
        messageId(e.authorId, e.targetSentAt),
        applyDelete,
      );
      await this.recomputeUnread(e.conversationId);
    });
    on('reaction', (e) =>
      this.updateMessage(e.conversationId, messageId(e.targetAuthorId, e.targetSentAt), (m) => ({
        ...m,
        reactions: applyReaction(m.reactions, e.reaction, e.remove),
      })),
    );
    on('receipt', (e) => this.onReceipt(e));
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
    on('readSync', (e) => this.onReadSync(e));
    on(
      'conversationUpdated',
      (conv) => {
        const existing = this.deps.stores.conversations.getState().byId[conv.id];
        // Keep local-only knowledge: newest activity and drafts.
        const merged: Conversation = {
          ...conv,
          lastActivityAt: Math.max(conv.lastActivityAt, existing?.lastActivityAt ?? 0),
          ...(existing?.draft === undefined ? {} : { draft: existing.draft }),
        };
        this.deps.stores.conversations.getState().upsert(merged);
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
  }

  private async run(event: string, fn: () => Promise<void> | void): Promise<void> {
    try {
      await fn();
    } catch (error) {
      // One bad event must not stall the queue.
      this.onError(error, `sync: ${event} handler failed`);
    }
  }

  private async onMessage(message: Message): Promise<void> {
    const { repository, stores } = this.deps;
    const id = message.conversationId;
    await repository.put(message);
    stores.messages.getState().upsert(message);
    stores.conversations.getState().bumpActivity(id, message.sentAt);
    stores.typing.getState().setTyping(id, message.authorId, false, this.deps.clock.now());

    if (!stores.conversations.getState().byId[id]) void this.refreshConversations();

    await this.updateReadState(message);
    this.events.emit('message', message);
  }

  private async updateReadState(message: Message): Promise<void> {
    const { repository, stores } = this.deps;
    const id = message.conversationId;
    const selfId = stores.session.getState().self?.id;
    if (!selfId) return;
    if (message.authorId === selfId) {
      // Sent from another of our devices: we've evidently read up to here.
      if (stores.conversations.getState().markRead(id, message.sentAt)) {
        await repository.setReadCursor(id, message.sentAt);
      }
    } else if (this.isViewing(id)) {
      await this.markConversationRead(id);
    } else {
      stores.conversations.getState().applyIncoming(message, selfId);
    }
  }

  private async updateMessage(
    conversationId: ConversationId,
    id: MessageId,
    fn: (m: Message) => Message,
  ): Promise<void> {
    await this.deps.repository.update(id, fn);
    this.deps.stores.messages.getState().update(conversationId, id, fn);
  }

  private async onReceipt(e: BackendEvents['receipt']): Promise<void> {
    const selfId = this.deps.stores.session.getState().self?.id;
    if (!selfId) return;
    const status = RECEIPT_STATUS[e.type];
    for (const sentAt of e.sentAts) {
      const id = messageId(selfId, sentAt);
      const updated = await this.deps.repository.update(id, (m) => ({
        ...m,
        status: advanceStatus(m.status, status),
      }));
      const conversationId = updated?.conversationId ?? this.findLoaded(id);
      if (!conversationId) continue;
      this.deps.stores.messages.getState().update(conversationId, id, (m) => {
        const next = advanceStatus(m.status, status);
        return next === m.status ? m : { ...m, status: next };
      });
    }
  }

  /** Receipts can outrun persistence of our own send; fall back to loaded windows. */
  private findLoaded(id: MessageId): ConversationId | undefined {
    const windows = this.deps.stores.messages.getState().windows;
    for (const [conv, w] of Object.entries(windows)) {
      if (id in w.byId) return conv as ConversationId;
    }
    return undefined;
  }

  private async onReadSync(e: BackendEvents['readSync']): Promise<void> {
    const latestByConv = new Map<ConversationId, number>();
    for (const ref of e.messages) {
      const m = await this.deps.repository.get(messageId(ref.authorId, ref.sentAt));
      if (!m) continue;
      latestByConv.set(
        m.conversationId,
        Math.max(latestByConv.get(m.conversationId) ?? 0, m.sentAt),
      );
    }
    const conversations = this.deps.stores.conversations.getState();
    for (const [conv, sentAt] of latestByConv) {
      if ((conversations.readCursors[conv] ?? 0) >= sentAt) continue;
      conversations.setReadCursors({ [conv]: sentAt });
      await this.deps.repository.setReadCursor(conv, sentAt);
      await this.recomputeUnread(conv);
    }
  }

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

  private async refreshConversations(): Promise<void> {
    if (this.refreshingConversations) return;
    this.refreshingConversations = true;
    try {
      const conversations = await this.deps.backend.listConversations();
      this.deps.stores.conversations.getState().upsertMany(conversations);
    } catch (error) {
      this.onError(error, 'conversation refresh failed');
    } finally {
      this.refreshingConversations = false;
    }
  }
}
