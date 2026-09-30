/**
 * Pages conversation history into the messages store.
 *
 * The repository is the source of truth. Backends that keep server-side
 * history (only the mock today) backfill the repository when local history
 * runs out, via the optional ChatBackend.fetchHistory.
 */
import type { ChatBackend } from '@/core/backend';
import type { ConversationId, Message } from '@/core/domain';
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

  /** Loads the newest page if the conversation hasn't been opened yet. */
  ensureLoaded(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (window?.loaded) return Promise.resolve();
    return this.once(conversationId, async () => {
      const { messages, hasMoreBefore } = await this.fetchPage(conversationId, undefined);
      this.deps.stores.messages.getState().setInitialPage(conversationId, messages, hasMoreBefore);
    });
  }

  /** Loads the page before the oldest loaded message. No-op when nothing more exists. */
  loadOlder(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (!window?.loaded) return this.ensureLoaded(conversationId);
    if (!window.hasMoreBefore) return Promise.resolve();
    const oldestId = window.ids.find((id) => !id.startsWith('pending:'));
    const before = oldestId ? window.byId[oldestId]?.sentAt : undefined;
    return this.once(conversationId, async () => {
      const { messages, hasMoreBefore } = await this.fetchPage(conversationId, before);
      this.deps.stores.messages.getState().prependPage(conversationId, messages, hasMoreBefore);
    });
  }

  /** Coalesces concurrent loads per conversation and tracks the loading flag. */
  private once(conversationId: ConversationId, fn: () => Promise<void>): Promise<void> {
    const existing = this.inflight.get(conversationId);
    if (existing) return existing;
    const store = this.deps.stores.messages.getState();
    store.setLoading(conversationId, true);
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

  private async fetchPage(
    conversationId: ConversationId,
    before: number | undefined,
  ): Promise<{ messages: Message[]; hasMoreBefore: boolean }> {
    const { repository, backend } = this.deps;
    const limit = this.pageSize;
    const local = await repository.page(
      conversationId,
      before === undefined ? { limit } : { before, limit },
    );
    if (local.length === limit) return { messages: local, hasMoreBefore: true };
    if (!backend.fetchHistory) return { messages: local, hasMoreBefore: false };

    // Local history ran out: backfill from the backend, older than what we have.
    const oldest = local[0]?.sentAt ?? before;
    const remote = await backend.fetchHistory(
      conversationId,
      oldest === undefined
        ? { limit: limit - local.length }
        : { before: oldest, limit: limit - local.length },
    );
    await repository.putMany(remote.messages);
    return { messages: [...remote.messages, ...local], hasMoreBefore: remote.hasMoreBefore };
  }
}
