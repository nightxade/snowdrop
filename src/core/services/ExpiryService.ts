/**
 * Disappearing messages: the purge schedule and the purge itself, the
 * tombstones that stop a purged message coming back, and the countdowns of
 * messages imported from the history archive (recovering them after a
 * restart, starting them once the user sees the message).
 *
 * SyncService owns the queue, the connection and the generation; it attaches
 * itself (see {@link ExpiryHost}) so the purge runs inside that queue and
 * stale work is dropped after a stop, exactly as when this lived there.
 */
import type { ChatBackend } from '@/core/backend';
import type { ConversationId, Message, MessageId } from '@/core/domain';
import type { Cancel, Clock, Scheduler } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { refreshPreviewAfterRemoval } from './sidebarPreview';
import { consoleReporter, type ErrorReporter } from './types';

export interface ExpiryServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  scheduler: Scheduler;
  /** How often expired (disappearing) messages are purged. */
  purgeIntervalMs?: number;
  onError?: ErrorReporter;
}

/** What the sync engine lends this service: its connection, queue and generation. */
export interface ExpiryHost {
  /** Whether a connect has finished (the purge timer only runs then). */
  isConnected: () => boolean;
  /** Bumped by the engine on stop; async work from an older generation is dropped. */
  generation: () => number;
  /** Runs `task` on the engine's event queue, behind whatever is already queued. */
  runQueued: (name: string, task: () => Promise<void>) => void;
  /** A message is gone: whatever was said about it stops applying. */
  announceRemoved: (message: Message) => void;
}

/** How many purged message ids are remembered to suppress re-delivery. */
const PURGED_TOMBSTONES = 2_000;

/** Messages handled per purge or recovery batch. */
const BATCH = 500;

export class ExpiryService {
  private readonly onError: ErrorReporter;
  private host: ExpiryHost = {
    isConnected: () => false,
    generation: () => 0,
    runQueued: () => undefined,
    announceRemoved: () => undefined,
  };
  private purgeTimer: Cancel | null = null;
  private nextPurgeAt = Infinity;
  private readonly readingHistory = new Set<MessageId>();
  /**
   * Tombstones of purged disappearing messages (bounded, oldest evicted).
   * In memory only: after a reload, a replayed message is already past its
   * `expiresAt` (adapters derive it from the server receive time) and is
   * dropped by the check in onMessage instead.
   */
  private readonly purged = new Set<MessageId>();

  constructor(private readonly deps: ExpiryServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Called by the sync engine that owns the queue this service purges on. */
  attach(host: ExpiryHost): void {
    this.host = host;
  }

  /** Cancels the purge timer (the engine's stop). */
  teardown(): void {
    this.purgeTimer?.();
    this.purgeTimer = null;
  }

  /** Whether a message was purged (and so must not be brought back by a late event). */
  hasPurged(id: MessageId): boolean {
    return this.purged.has(id);
  }

  /** Remembers a purged message id so a re-delivery is dropped. */
  rememberPurged(id: MessageId): void {
    this.purged.add(id);
    if (this.purged.size > PURGED_TOMBSTONES) {
      const oldest = this.purged.values().next().value;
      if (oldest !== undefined) this.purged.delete(oldest);
    }
  }

  /** Purges expired messages after `delayMs` (and then periodically while running). */
  schedulePurge(delayMs: number): void {
    // Not while stopped (`teardown()` cancels the timer); a connect that has
    // finished is no reason to stop purging.
    if (!this.host.isConnected()) return;
    const at = this.deps.clock.now() + Math.max(0, delayMs);
    if (this.purgeTimer && at >= this.nextPurgeAt) return;
    this.purgeTimer?.();
    this.nextPurgeAt = at;
    this.purgeTimer = this.deps.scheduler.setTimeout(() => {
      this.purgeTimer = null;
      this.nextPurgeAt = Infinity;
      this.host.runQueued('purge', async () => {
        await this.purgeExpired();
      });
      this.schedulePurge(this.deps.purgeIntervalMs ?? 30_000);
    }, at - this.deps.clock.now());
  }

  /** Purges at `at` (epoch ms) a message whose timer was set outside this service (one just sent). */
  noteExpiry(at: number): void {
    this.schedulePurge(at - this.deps.clock.now());
  }

  /** Deletes disappearing messages whose time is up, locally and in the UI. */
  async purgeExpired(): Promise<number> {
    const { repository, clock } = this.deps;
    const selfId = this.selfId();
    const expired = await repository.expired(clock.now(), BATCH);
    for (const m of expired) {
      await repository.delete(m.id);
      await this.removeLocal(m, selfId);
      this.host.announceRemoved(m);
    }
    return expired.length;
  }

  /**
   * A message already deleted from the repository leaves the rest of the
   * app: tombstoned, out of the window, out of the unread count, and off the
   * sidebar preview if it was that.
   */
  private async removeLocal(message: Message, selfId: string | undefined): Promise<void> {
    const { repository, stores } = this.deps;
    this.rememberPurged(message.id);
    stores.messages.getState().remove(message.conversationId, message.id);
    if (selfId) stores.conversations.getState().applyRemoval(message, selfId);
    await refreshPreviewAfterRemoval(
      stores.conversations,
      repository,
      message.conversationId,
      message,
    );
  }

  private selfId(): string | undefined {
    return this.deps.stores.session.getState().self?.id;
  }

  /** Recover a server-committed read whose local write was interrupted. */
  async recoverHistoryTimers(): Promise<void> {
    const { backend, repository, stores, clock } = this.deps;
    if (!backend.capabilities.features.has('historyArchive')) return;
    const generation = this.host.generation();
    const pending = await repository.pendingHistoryTimers();
    for (let start = 0; start < pending.length; start += BATCH) {
      if (generation !== this.host.generation()) return;
      const batch = pending.slice(start, start + BATCH);
      const selected = new Map(batch.map((message) => [message.id, message]));
      const states = await backend.getHistoryReadState(
        batch.flatMap((message) =>
          message.historyCursor ? [{ id: message.id, cursor: message.historyCursor }] : [],
        ),
      );
      if (generation !== this.host.generation()) return;
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
          if (generation !== this.host.generation()) return;
          await this.removeLocal(message, this.selfId());
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
          if (generation !== this.host.generation()) return;
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
    const generation = this.host.generation();
    const claimed = [...new Set(ids)].filter((id) => !this.readingHistory.has(id));
    for (const id of claimed) this.readingHistory.add(id);
    try {
      const selected = new Map<MessageId, Message>();
      for (const id of claimed) {
        const message = await repository.get(id);
        if (generation !== this.host.generation()) return;
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
      if (generation !== this.host.generation()) return;
      for (const state of states) {
        const original = selected.get(state.id);
        if (!original) continue;
        if (
          state.expiresAt !== undefined &&
          (!Number.isSafeInteger(state.expiresAt) || state.expiresAt <= 0)
        )
          throw new Error('History timer response has an invalid deadline');
        const current = await repository.get(state.id);
        if (generation !== this.host.generation()) return;
        if (!current || current.historyCursor !== original.historyCursor) continue;
        if (
          state.unavailable ||
          (state.expiresAt !== undefined && state.expiresAt <= clock.now())
        ) {
          await repository.delete(state.id);
          if (generation !== this.host.generation()) return;
          await this.removeLocal(current, this.selfId());
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
        if (generation !== this.host.generation()) return;
        if (updated) stores.messages.getState().update(conversationId, state.id, () => updated);
        this.schedulePurge(expiresAt - clock.now());
      }
    } catch (error) {
      if (generation === this.host.generation())
        this.onError(error, 'starting history expiration failed');
    } finally {
      for (const id of claimed) this.readingHistory.delete(id);
    }
  }
}
