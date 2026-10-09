/**
 * Pages conversation history into the messages store.
 *
 * The repository is the source of truth; backends that keep server-side
 * history backfill it when local history runs out.
 * Windows can be anchored to the present or detached around an older message
 * (search results, reply jumps); see MessagesStore.
 *
 * Concurrency, per conversation:
 * - Paging (`loadOlder`/`loadNewer`) coalesces with an in-flight page load.
 * - A jump (`jumpTo`/`jumpToPresent`, and so `open`) always runs: it bumps a
 *   generation token that supersedes whatever is in flight, whose results are
 *   then discarded instead of overwriting the newer window.
 * - Whenever a load leaves the window anchored to the present, it catches up
 *   on messages stored while it was loading (the live path skips windows that
 *   aren't loaded yet), so nothing that arrives mid-load is lost.
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

type IsCurrent = () => boolean;

export class HistoryService {
  private readonly pageSize: number;
  private readonly onError: ErrorReporter;
  private readonly generation = new Map<ConversationId, number>();
  private readonly paging = new Map<ConversationId, Promise<void>>();
  private readonly jumping = new Map<ConversationId, Promise<void>>();
  private readonly active = new Map<ConversationId, number>();

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

  /** Loads the newest page if the conversation hasn't been loaded (or isn't loading) yet. */
  ensureLoaded(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (window?.loaded) return Promise.resolve();
    return this.jumping.get(conversationId) ?? this.jumpToPresent(conversationId);
  }

  /** Replaces the window with the newest page (re-anchors to the present). */
  jumpToPresent(conversationId: ConversationId): Promise<void> {
    return this.jump(conversationId, async (isCurrent) => {
      const { messages, hasMoreBefore } = await this.olderPage(conversationId, undefined);
      if (!isCurrent()) return;
      this.deps.stores.messages
        .getState()
        .replaceWindow(conversationId, messages, { hasMoreBefore, hasMoreAfter: false });
      await this.catchUp(conversationId, isCurrent);
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
    let applied = false;
    await this.jump(conversationId, async (isCurrent) => {
      const [before, after] = await Promise.all([
        this.deps.repository.page(conversationId, { before: seq, limit: half }),
        this.deps.repository.page(conversationId, { after: seq, limit: half }),
      ]);
      if (!isCurrent()) return;
      const hasMoreAfter = after.length === half;
      this.deps.stores.messages
        .getState()
        .replaceWindow(conversationId, [...before, target, ...after], {
          hasMoreBefore: before.length === half || this.deps.backend.fetchHistory !== undefined,
          hasMoreAfter,
        });
      applied = true;
      if (!hasMoreAfter) await this.catchUp(conversationId, isCurrent);
    });
    return applied;
  }

  /**
   * Jumps to the first message after a read position that someone else sent
   * (the "N new messages" bar when the divider isn't loaded). Resolves with
   * its id, or null if there is none.
   */
  async jumpToFirstUnread(
    conversationId: ConversationId,
    afterSeq: number,
    selfId: string | null,
  ): Promise<MessageId | null> {
    const page = await this.deps.repository.page(conversationId, {
      after: afterSeq,
      limit: this.pageSize,
    });
    const first = page.find((m) => m.authorId !== selfId && m.kind === 'normal') ?? page[0];
    if (!first) return null;
    return (await this.jumpTo(conversationId, first.id)) ? first.id : null;
  }

  /** Loads the page before the oldest loaded message. */
  loadOlder(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (!window?.loaded) return this.ensureLoaded(conversationId);
    if (!window.hasMoreBefore) return Promise.resolve();
    return this.page(conversationId, async (isCurrent) => {
      const oldest = this.edge(conversationId, 'oldest');
      const { messages, hasMoreBefore } = await this.olderPage(conversationId, oldest);
      if (!isCurrent()) return;
      this.deps.stores.messages.getState().prependPage(conversationId, messages, hasMoreBefore);
    });
  }

  /** Loads the page after the newest loaded message (detached windows only). */
  loadNewer(conversationId: ConversationId): Promise<void> {
    const window = this.deps.stores.messages.getState().windows[conversationId];
    if (!window?.loaded || window.anchoredToPresent) return Promise.resolve();
    const newest = this.edge(conversationId, 'newest');
    if (newest?.seq === undefined) return this.jumpToPresent(conversationId);
    return this.page(conversationId, async (isCurrent) => {
      const after = this.edge(conversationId, 'newest')?.seq ?? newest.seq ?? 0;
      const messages = await this.deps.repository.page(conversationId, {
        after,
        limit: this.pageSize,
      });
      if (!isCurrent()) return;
      const hasMoreAfter = messages.length === this.pageSize;
      this.deps.stores.messages.getState().appendPage(conversationId, messages, hasMoreAfter);
      if (!hasMoreAfter) await this.catchUp(conversationId, isCurrent);
    });
  }

  /**
   * After a load leaves the window anchored, pulls in anything stored since
   * the page was read. Repeats until the repository has nothing newer.
   */
  private async catchUp(conversationId: ConversationId, isCurrent: IsCurrent): Promise<void> {
    for (;;) {
      const w = this.deps.stores.messages.getState().windows[conversationId];
      if (!w?.anchoredToPresent || !isCurrent()) return;
      const after = this.edge(conversationId, 'newest')?.seq ?? Number.NEGATIVE_INFINITY;
      const newer = await this.deps.repository.page(conversationId, {
        after,
        limit: this.pageSize,
      });
      if (!isCurrent()) return;
      const fresh = newer.filter(
        (m) =>
          !(m.id in (this.deps.stores.messages.getState().windows[conversationId]?.byId ?? {})),
      );
      if (fresh.length === 0) return;
      this.deps.stores.messages.getState().appendPage(conversationId, fresh, false);
      if (newer.length < this.pageSize) return;
    }
  }

  private edge(conversationId: ConversationId, which: 'oldest' | 'newest'): Message | undefined {
    const w = this.deps.stores.messages.getState().windows[conversationId];
    if (!w) return undefined;
    // Optimistic rows sit at the edge with reserved seqs; they're still valid bounds.
    const id = which === 'oldest' ? w.ids[0] : w.ids.at(-1);
    return id === undefined ? undefined : w.byId[id];
  }

  /** A jump supersedes every in-flight load for the conversation. */
  private jump(
    conversationId: ConversationId,
    fn: (isCurrent: IsCurrent) => Promise<void>,
  ): Promise<void> {
    const generation = (this.generation.get(conversationId) ?? 0) + 1;
    this.generation.set(conversationId, generation);
    // Later page requests must not coalesce into a superseded load.
    this.paging.delete(conversationId);
    const run = this.track(conversationId, generation, fn);
    this.jumping.set(conversationId, run);
    void run.finally(() => {
      if (this.jumping.get(conversationId) === run) this.jumping.delete(conversationId);
    });
    return run;
  }

  /** Page loads coalesce with an in-flight page load of the same generation. */
  private page(
    conversationId: ConversationId,
    fn: (isCurrent: IsCurrent) => Promise<void>,
  ): Promise<void> {
    const existing = this.paging.get(conversationId);
    if (existing) return existing;
    const run = this.track(conversationId, this.generation.get(conversationId) ?? 0, fn);
    this.paging.set(conversationId, run);
    void run.finally(() => {
      if (this.paging.get(conversationId) === run) this.paging.delete(conversationId);
    });
    return run;
  }

  /** Runs a load with error reporting and a loading flag that covers overlapping loads. */
  private track(
    conversationId: ConversationId,
    generation: number,
    fn: (isCurrent: IsCurrent) => Promise<void>,
  ): Promise<void> {
    const isCurrent: IsCurrent = () => (this.generation.get(conversationId) ?? 0) === generation;
    this.active.set(conversationId, (this.active.get(conversationId) ?? 0) + 1);
    this.deps.stores.messages.getState().setLoading(conversationId, true);
    return fn(isCurrent)
      .catch((error: unknown) => {
        this.onError(error, 'loading history failed');
      })
      .finally(() => {
        const remaining = (this.active.get(conversationId) ?? 1) - 1;
        this.active.set(conversationId, remaining);
        if (remaining === 0) this.deps.stores.messages.getState().setLoading(conversationId, false);
      });
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
        : {
            before: boundary.sentAt,
            beforeId: boundary.id,
            ...(boundary.historyCursor ? { beforeCursor: boundary.historyCursor } : {}),
            limit: limit - local.length,
          },
    );
    const stored = await repository.upsertMany(remote.messages, {
      backfill: true,
      merge: mergeDuplicate,
    });
    return { messages: [...stored, ...local], hasMoreBefore: remote.hasMoreBefore };
  }
}
