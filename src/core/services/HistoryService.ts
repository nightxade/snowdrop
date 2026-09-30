/**
 * Pages conversation history into the messages store.
 *
 * The repository is the source of truth; backends that keep server-side
 * history (only the mock today) backfill it when local history runs out.
 * Windows can be anchored to the present or detached around an older message
 * (search results, reply jumps); see MessagesStore.
 */
import type { ChatBackend } from '@/core/backend';
import { mergeDuplicate, type ConversationId, type Message, type MessageId } from '@/core/domain';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

export interface HistoryServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  pageSize?: number;
  onError?: ErrorReporter;
}

export class HistoryService {
  private readonly pageSize: number;
  private readonly onError: ErrorReporter;
  private readonly inflight = new Map<ConversationId, Promise<void>>();

  constructor(private readonly deps: HistoryServiceDeps) {
    this.pageSize = deps.pageSize ?? 50;
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Opening a conversation: snapshots the read cursor for the "new messages"
   * divider (so auto-mark-read doesn't move it) and loads the newest page.
   */
  async open(conversationId: ConversationId): Promise<void> {
    const cursor = this.deps.stores.conversations.getState().readCursors[conversationId];
    this.deps.stores.ui.getState().setUnreadMarker(conversationId, cursor ?? null);
    await this.ensureLoaded(conversationId);
  }

  /** Loads the newest page if the conversation hasn't been loaded yet. */
  ensureLoaded(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (window?.loaded) return Promise.resolve();
    return this.jumpToPresent(conversationId);
  }

  /** Replaces the window with the newest page (re-anchors to the present). */
  jumpToPresent(conversationId: ConversationId): Promise<void> {
    return this.once(conversationId, async () => {
      const { messages, hasMoreBefore } = await this.olderPage(conversationId, undefined);
      this.deps.stores.messages
        .getState()
        .replaceWindow(conversationId, messages, { hasMoreBefore, hasMoreAfter: false });
    });
  }

  /**
   * Replaces the window with the history around one message (search result,
   * quote click). Resolves false if the message isn't in local history.
   */
  async jumpTo(conversationId: ConversationId, id: MessageId): Promise<boolean> {
    const target = await this.deps.repository.get(id);
    if (target?.seq === undefined || target.conversationId !== conversationId) return false;
    const seq = target.seq;
    const half = Math.ceil(this.pageSize / 2);
    await this.once(conversationId, async () => {
      const [before, after] = await Promise.all([
        this.deps.repository.page(conversationId, { before: seq, limit: half }),
        this.deps.repository.page(conversationId, { after: seq, limit: half }),
      ]);
      this.deps.stores.messages
        .getState()
        .replaceWindow(conversationId, [...before, target, ...after], {
          hasMoreBefore: before.length === half || this.deps.backend.fetchHistory !== undefined,
          hasMoreAfter: after.length === half,
        });
    });
    return true;
  }

  /** Loads the page before the oldest loaded message. */
  loadOlder(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (!window?.loaded) return this.ensureLoaded(conversationId);
    if (!window.hasMoreBefore) return Promise.resolve();
    const oldest = this.edge(conversationId, 'oldest');
    return this.once(conversationId, async () => {
      const { messages, hasMoreBefore } = await this.olderPage(conversationId, oldest);
      this.deps.stores.messages.getState().prependPage(conversationId, messages, hasMoreBefore);
    });
  }

  /** Loads the page after the newest loaded message (detached windows only). */
  loadNewer(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (!window?.loaded || window.anchoredToPresent) return Promise.resolve();
    const newest = this.edge(conversationId, 'newest');
    if (newest?.seq === undefined) return this.jumpToPresent(conversationId);
    const after = newest.seq;
    return this.once(conversationId, async () => {
      const messages = await this.deps.repository.page(conversationId, {
        after,
        limit: this.pageSize,
      });
      this.deps.stores.messages
        .getState()
        .appendPage(conversationId, messages, messages.length === this.pageSize);
    });
  }

  private edge(conversationId: ConversationId, which: 'oldest' | 'newest'): Message | undefined {
    const w = this.deps.stores.messages.getState().windows[conversationId];
    if (!w) return undefined;
    const id = which === 'oldest' ? w.ids[0] : w.ids.at(-1);
    return id === undefined ? undefined : w.byId[id];
  }

  /** Coalesces concurrent loads per conversation and tracks the loading flag. */
  private once(conversationId: ConversationId, fn: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(conversationId);
    if (existing) return existing;
    this.deps.stores.messages.getState().setLoading(conversationId, true);
    const run = fn()
      .catch((error: unknown) => {
        this.onError(error, 'loading history failed');
      })
      .finally(() => {
        this.inflight.delete(conversationId);
        this.deps.stores.messages.getState().setLoading(conversationId, false);
      });
    this.inflight.set(conversationId, run);
    return run;
  }

  /** A page older than `oldest` (or the newest page), backfilling from the backend if needed. */
  private async olderPage(
    conversationId: ConversationId,
    oldest: Message | undefined,
  ): Promise<{ messages: Message[]; hasMoreBefore: boolean }> {
    const { repository, backend } = this.deps;
    const limit = this.pageSize;
    const local = await repository.page(
      conversationId,
      oldest?.seq === undefined ? { limit } : { before: oldest.seq, limit },
    );
    if (local.length === limit) return { messages: local, hasMoreBefore: true };
    if (!backend.fetchHistory) return { messages: local, hasMoreBefore: false };

    // Local history ran out: backfill from the backend, older than what we have.
    const boundary = local[0] ?? oldest;
    const remote = await backend.fetchHistory(
      conversationId,
      boundary === undefined
        ? { limit: limit - local.length }
        : { before: boundary.sentAt, limit: limit - local.length },
    );
    const stored = await repository.upsertMany(remote.messages, {
      backfill: true,
      merge: mergeDuplicate,
    });
    return { messages: [...stored, ...local], hasMoreBefore: remote.hasMoreBefore };
  }
}
