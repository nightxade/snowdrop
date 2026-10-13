/**
 * One-time background import of a backend's whole history archive into the
 * repository, so search, jump-to-message and anything else repository-based
 * cover everything the account has — not just what the user has scrolled
 * through (HistoryService pages the rest on demand).
 *
 * Reuses the same conversion `HistoryService` uses for on-demand backfill
 * (`backend.fetchHistory`, which wraps the archive → domain `Message`
 * conversion in `core/backend/signal-cli/history/`): this service just walks
 * every conversation's pages to completion instead of stopping at the
 * window's edge, and writes them straight to the repository rather than a
 * message-store window.
 *
 * Capability: a backend only has something to import if it exposes
 * `getHistoryArchiveId` *and* that resolves to a non-null id (patched
 * signal-cli after a "transfer message history" link, with the archive
 * still loaded). This is the one place that decision is made; backends
 * without it (the demo, upstream signal-cli, a link with no transfer) are
 * never touched by this service. `fetchHistory` being present but the
 * archive id being null (upstream signal-cli, no archive) also counts as
 * nothing to import.
 *
 * Idempotency: every page is written with `repository.upsertMany(...,
 * {backfill: true, merge: mergeDuplicate})` — exactly how `HistoryService`'s
 * on-demand paging writes backfilled history. A message already stored
 * (seeded at startup, arrived live, or paged in on demand) is merged and
 * keeps its seq; only messages genuinely new to the repository get fresh,
 * older seqs. Re-running this service, or running it while the user scrolls
 * up in a conversation, can never duplicate a message — both paths write
 * through the same (serialised, per-repository) mutation path.
 *
 * Resume: a small persisted record (per backend/account scope, so switching
 * accounts can't mix up cursors) tracks, per conversation, the oldest
 * archive cursor reached so far and whether that conversation is fully
 * walked, plus the archive id the record belongs to. A quit mid-import
 * resumes every conversation from its own cursor; a finished import
 * (`status: 'done'`) short-circuits on every later `start()` unless the
 * archive id has changed (a relink produced a new archive, whose cursors
 * mean something else entirely — the old record is discarded and a fresh
 * import begins). New conversations that appear while an import is running
 * are picked up by the same walk (see the fixed-point loop in `doRun`).
 *
 * Side effects: none, deliberately. This only ever calls
 * `repository.upsertMany`, never touches `stores.messages` /
 * `stores.conversations`, and never emits anything `SyncService`/
 * `NotificationService` would treat as a new arrival — imported messages
 * are history, not events. The on-demand path still finds them: it checks
 * the repository before ever calling the backend.
 *
 * Pausing: never runs while the session isn't `ready` yet, or is
 * `catchingUp` (SyncService's CatchUpTracker) — both read from the session
 * store, so a reconnect pauses an in-flight import the same way startup
 * does, and it resumes on its own once the condition clears.
 */
import type { ChatBackend } from '@/core/backend';
import { mergeDuplicate, type ConversationId } from '@/core/domain';
import type { Clock, Logger, Scheduler } from '@/core/lib';
import { createLogger } from '@/core/lib';
import {
  isRecord,
  loadVersioned,
  saveVersioned,
  type KeyValueStorage,
  type MessageRepository,
  type VersionedSchema,
} from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { consoleReporter, type ErrorReporter } from './types';

const log = createLogger('history-import');

const SCHEMA_VERSION = 1;
/** Conversations per yield; "modest" on purpose — this is a background job, never urgent. */
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_YIELD_MS = 50;

interface StoredCursor {
  /** The oldest archive cursor reached so far for this conversation. */
  cursor?: string;
  /** True once the backend reports no more history before `cursor`. */
  done: boolean;
}

interface HistoryImportState {
  archiveId: string;
  status: 'importing' | 'done' | 'failed';
  conversations: Record<string, StoredCursor>;
  /** Messages written across this and any earlier (resumed) runs. */
  imported: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

function parseCursor(value: unknown): StoredCursor | null {
  if (!isRecord(value) || typeof value.done !== 'boolean') return null;
  if (value.cursor !== undefined && typeof value.cursor !== 'string') return null;
  return { done: value.done, ...(value.cursor !== undefined ? { cursor: value.cursor } : {}) };
}

function parseState(data: unknown): HistoryImportState | null {
  if (!isRecord(data)) return null;
  const { archiveId, status, conversations, imported, startedAt, finishedAt, error } = data;
  if (typeof archiveId !== 'string' || !archiveId) return null;
  if (status !== 'importing' && status !== 'done' && status !== 'failed') return null;
  if (!isRecord(conversations) || typeof imported !== 'number' || typeof startedAt !== 'number')
    return null;
  const parsedConversations: Record<string, StoredCursor> = {};
  for (const [id, raw] of Object.entries(conversations)) {
    const cursor = parseCursor(raw);
    if (cursor) parsedConversations[id] = cursor;
  }
  return {
    archiveId,
    status,
    conversations: parsedConversations,
    imported,
    startedAt,
    ...(typeof finishedAt === 'number' ? { finishedAt } : {}),
    ...(typeof error === 'string' ? { error } : {}),
  };
}

function schemaFor(key: string): VersionedSchema<HistoryImportState | null> {
  return { key, version: SCHEMA_VERSION, defaults: () => null, parse: parseState };
}

export interface HistoryImportServiceDeps {
  /** Only the capability check and the paging call this service actually needs. */
  backend: Pick<ChatBackend, 'getHistoryArchiveId' | 'fetchHistory'>;
  repository: MessageRepository;
  stores: Stores;
  storage: KeyValueStorage;
  /**
   * The persisted record's scope (backend kind + account): callers already
   * compute this for spaces/local (`app/dataScope.ts`'s `scopeFor`); passed
   * in rather than imported so this stays an app-layer decision.
   */
  scope: () => string;
  clock: Clock;
  scheduler: Scheduler;
  onError?: ErrorReporter;
  /** Messages requested per backend page (default 100). */
  pageSize?: number;
  /** Delay between pages, so the walk never hogs the event loop (default 50ms). */
  yieldMs?: number;
  log?: Logger;
}

const KEY_PREFIX = 'snowdrop.historyImport';

export class HistoryImportService {
  private readonly pageSize: number;
  private readonly yieldMs: number;
  private readonly onError: ErrorReporter;
  private readonly log: Logger;
  private running: Promise<void> | null = null;
  private stopped = false;
  private wake: (() => void)[] = [];

  constructor(private readonly deps: HistoryImportServiceDeps) {
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    this.yieldMs = deps.yieldMs ?? DEFAULT_YIELD_MS;
    this.onError = deps.onError ?? consoleReporter;
    this.log = deps.log ?? log;
  }

  /**
   * Starts (or resumes) the import if the backend has an archive and it
   * isn't already fully imported. Safe to call repeatedly — concurrent
   * calls share the same run, and a call once it has finished just resolves.
   */
  start(): Promise<void> {
    this.stopped = false;
    this.running ??= this.doRun().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** Same as `start()`, named for Settings' "failed — Retry" action. */
  retry(): Promise<void> {
    return this.start();
  }

  /** Stops an in-flight run (app shutdown); resolves once it has unwound. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.wakeAll();
    await (this.running ?? Promise.resolve()).catch(() => undefined);
  }

  /**
   * "Clear history" wiped the repository: the archive is still on
   * signal-cli, so a finished import no longer reflects what's stored
   * locally. Drops the persisted record (next `start()` imports from
   * scratch) and resets the session indicator to idle.
   */
  reset(): void {
    this.stopped = true;
    this.wakeAll();
    this.deps.storage.removeItem(this.key());
    this.publish(null);
  }

  private key(): string {
    return `${KEY_PREFIX}:${this.deps.scope()}`;
  }

  private loadState(): HistoryImportState | null {
    return loadVersioned(this.deps.storage, schemaFor(this.key()));
  }

  private saveState(state: HistoryImportState): void {
    saveVersioned(this.deps.storage, schemaFor(this.key()), state);
  }

  private wakeAll(): void {
    const waiters = this.wake.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** Resolves once the session is ready and not catching up, or false if stopped first. */
  private async waitUntilRunnable(): Promise<boolean> {
    for (;;) {
      if (this.stopped) return false;
      const session = this.deps.stores.session.getState();
      if (session.ready && !session.catchingUp) return true;
      await new Promise<void>((resolve) => {
        this.wake.push(resolve);
        const unsubscribe = this.deps.stores.session.subscribe(() => {
          unsubscribe();
          resolve();
        });
      });
    }
  }

  private yield(): Promise<void> {
    return new Promise((resolve) => {
      this.deps.scheduler.setTimeout(resolve, this.yieldMs);
    });
  }

  private async doRun(): Promise<void> {
    if (!(await this.waitUntilRunnable())) return;

    let archiveId: string | null;
    try {
      archiveId = (await this.deps.backend.getHistoryArchiveId?.()) ?? null;
    } catch (error) {
      this.onError(error, 'checking for an importable history archive failed');
      return;
    }
    const rawFetchHistory = this.deps.backend.fetchHistory;
    if (!archiveId || !rawFetchHistory) {
      this.publish(null);
      return;
    }
    // Bound explicitly: callers below invoke this as a bare function, which
    // would otherwise lose the adapter's `this` (it reads its own fields).
    const fetchHistory = rawFetchHistory.bind(this.deps.backend);

    let state = this.loadState();
    // A relink produced a brand new archive; the old record's cursors
    // belong to an archive that no longer exists.
    if (state && state.archiveId !== archiveId) state = null;
    if (state?.status === 'done') {
      this.publish(state);
      return;
    }
    state ??= {
      archiveId,
      status: 'importing',
      conversations: {},
      imported: 0,
      startedAt: this.deps.clock.now(),
    };
    state.status = 'importing';
    delete state.error;
    this.saveState(state);
    this.publish(state);

    try {
      for (;;) {
        if (!(await this.waitUntilRunnable())) return;
        // Re-read conversation ids on every round: a chat that only shows up
        // in the archive (or one that arrives mid-import) still gets walked.
        const ids = Object.keys(this.deps.stores.conversations.getState().byId) as ConversationId[];
        const next = ids.find((id) => !state.conversations[id]?.done);
        if (next === undefined) break;
        // One conversation fully, to completion, before moving to the next —
        // simpler to resume correctly than interleaving pages across chats.
        while (!state.conversations[next]?.done) {
          if (!(await this.waitUntilRunnable())) return;
          await this.importConversation(next, state, fetchHistory);
        }
      }
      state.status = 'done';
      state.finishedAt = this.deps.clock.now();
      this.saveState(state);
      this.publish(state);
      this.log.info('history import finished', {
        imported: state.imported,
        conversations: Object.keys(state.conversations).length,
        ms: state.finishedAt - state.startedAt,
      });
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof Error ? error.message : String(error);
      this.saveState(state);
      this.publish(state);
      this.onError(error, 'history import failed');
    }
  }

  private async importConversation(
    id: ConversationId,
    state: HistoryImportState,
    fetchHistory: NonNullable<HistoryImportServiceDeps['backend']['fetchHistory']>,
  ): Promise<void> {
    const cursor = state.conversations[id]?.cursor;
    const page = await fetchHistory(id, {
      limit: this.pageSize,
      ...(cursor !== undefined ? { beforeCursor: cursor } : {}),
    });
    const stored = await this.deps.repository.upsertMany(page.messages, {
      backfill: true,
      merge: mergeDuplicate,
    });
    state.imported += stored.length;
    const oldest = page.messages[0];
    if (oldest && page.hasMoreBefore && !oldest.historyCursor)
      // Every archive-origin message carries a cursor; without one, the next
      // page request would repeat this one forever instead of advancing.
      throw new Error('History import got an archive page with no cursor to resume from');
    state.conversations[id] = oldest
      ? {
          done: !page.hasMoreBefore,
          ...(oldest.historyCursor ? { cursor: oldest.historyCursor } : {}),
        }
      : { done: true };
    this.saveState(state);
    this.publish(state);
    await this.yield();
  }

  private publish(state: HistoryImportState | null): void {
    if (!state) {
      this.deps.stores.session
        .getState()
        .setHistoryImport({ status: 'idle', percent: 0, imported: 0, error: null });
      return;
    }
    const total = Object.keys(this.deps.stores.conversations.getState().byId).length;
    const completed = Object.values(state.conversations).filter((c) => c.done).length;
    const percent =
      state.status === 'done'
        ? 100
        : total === 0
          ? 0
          : Math.min(99, Math.round((completed / total) * 100));
    this.deps.stores.session.getState().setHistoryImport({
      status: state.status,
      percent,
      imported: state.imported,
      error: state.error ?? null,
    });
  }
}
