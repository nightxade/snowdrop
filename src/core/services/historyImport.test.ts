import { describe, expect, it } from 'vitest';
import type { HistoryPage, HistoryQuery } from '@/core/backend';
import { directConversationId, messageId, type ConversationId, type Message } from '@/core/domain';
import { systemScheduler, type Clock } from '@/core/lib';
import {
  createMemoryStorage,
  MemoryMessageRepository,
  type KeyValueStorage,
  type MessageRepository,
} from '@/core/persistence';
import { createStores, type Stores } from '@/core/stores';
import { HistoryImportService } from './historyImport';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const SCOPE = 'signal-cli:+15551234567';

/** A conversation's archive: oldest to newest, each with a stable cursor. */
function archive(conversationId: ConversationId, authorId: string, count: number): Message[] {
  return Array.from({ length: count }, (_, i) => ({
    id: messageId(authorId, i + 1),
    conversationId,
    authorId,
    sentAt: i + 1,
    receivedAt: i + 1,
    body: `message ${i + 1}`,
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read' as const,
    kind: 'normal' as const,
    historyCursor: `archive-1:${i + 1}`,
  }));
}

/**
 * Minimal fake backend: only the two capabilities HistoryImportService uses.
 * Each conversation's full archive is handed in oldest-to-newest; fetchHistory
 * serves it the way the real adapter does (newest page first, walking older
 * pages by cursor).
 */
class FakeHistoryBackend {
  calls: { conversationId: ConversationId; query: HistoryQuery }[] = [];
  failConversation: ConversationId | null = null;

  constructor(
    public archiveId: string | null,
    private readonly chats: Map<ConversationId, Message[]>,
  ) {}

  getHistoryArchiveId(): Promise<string | null> {
    return Promise.resolve(this.archiveId);
  }

  fetchHistory(conversationId: ConversationId, query: HistoryQuery): Promise<HistoryPage> {
    this.calls.push({ conversationId, query });
    if (this.failConversation === conversationId) {
      return Promise.reject(new Error('archive unavailable'));
    }
    const all = this.chats.get(conversationId) ?? [];
    let endExclusive = all.length;
    if (query.beforeCursor !== undefined) {
      const index = all.findIndex((m) => m.historyCursor === query.beforeCursor);
      endExclusive = index === -1 ? 0 : index;
    }
    const start = Math.max(0, endExclusive - query.limit);
    return Promise.resolve({ messages: all.slice(start, endExclusive), hasMoreBefore: start > 0 });
  }
}

const clock: Clock = { now: () => NOW };

const CONV_A = directConversationId('alice');
const CONV_B = directConversationId('bob');

function seedConversations(stores: Stores, ids: ConversationId[]): void {
  stores.conversations.getState().upsertMany(
    ids.map((id) => ({
      id,
      kind: 'direct' as const,
      title: id,
      memberIds: [],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    })),
  );
}

interface Harness {
  backend: FakeHistoryBackend;
  repository: MessageRepository;
  stores: Stores;
  storage: KeyValueStorage;
  onErrors: unknown[];
}

function harness(
  overrides: Partial<{
    archiveId: string | null;
    chats: Map<ConversationId, Message[]>;
    storage: KeyValueStorage;
    stores: Stores;
    repository: MessageRepository;
  }> = {},
): Harness {
  const backend = new FakeHistoryBackend(
    'archiveId' in overrides ? (overrides.archiveId ?? null) : 'archive-1',
    overrides.chats ?? new Map<ConversationId, Message[]>(),
  );
  const repository = overrides.repository ?? new MemoryMessageRepository();
  const stores = overrides.stores ?? createStores();
  stores.session.getState().setReady(true);
  const storage = overrides.storage ?? createMemoryStorage();
  return { backend, repository, stores, storage, onErrors: [] };
}

function service(h: Harness, options: { pageSize?: number } = {}): HistoryImportService {
  return new HistoryImportService({
    backend: h.backend,
    repository: h.repository,
    stores: h.stores,
    storage: h.storage,
    scope: () => SCOPE,
    clock,
    scheduler: systemScheduler,
    yieldMs: 0,
    pageSize: options.pageSize ?? 2,
    onError: (error) => {
      h.onErrors.push(error);
    },
  });
}

describe('HistoryImportService', () => {
  it('pages every conversation to completion', async () => {
    const chats = new Map([
      [CONV_A, archive(CONV_A, 'alice', 5)],
      [CONV_B, archive(CONV_B, 'bob', 3)],
    ]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A, CONV_B]);

    await service(h).start();

    expect(await h.repository.count(CONV_A)).toBe(5);
    expect(await h.repository.count(CONV_B)).toBe(3);
    expect(h.stores.session.getState().historyImport).toMatchObject({
      status: 'done',
      percent: 100,
      imported: 8,
      error: null,
    });
  });

  it('nothing to import when the backend has no archive', async () => {
    const h = harness({ archiveId: null });
    seedConversations(h.stores, [CONV_A]);

    await service(h).start();

    expect(await h.repository.count(CONV_A)).toBe(0);
    expect(h.stores.session.getState().historyImport.status).toBe('idle');
  });

  it('resumes from the persisted cursor instead of refetching finished conversations', async () => {
    const chats = new Map([
      [CONV_A, archive(CONV_A, 'alice', 4)],
      [CONV_B, archive(CONV_B, 'bob', 4)],
    ]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A, CONV_B]);

    // First run: B fails partway, after A has already finished.
    h.backend.failConversation = CONV_B;
    await service(h).start();
    expect(await h.repository.count(CONV_A)).toBe(4);
    expect(await h.repository.count(CONV_B)).toBe(0);
    expect(h.stores.session.getState().historyImport.status).toBe('failed');

    // Second run (a fresh instance, same storage/repository): A must not be
    // refetched; B resumes from its own persisted cursor.
    h.backend.failConversation = null;
    h.backend.calls = [];
    await service(h).start();

    expect(await h.repository.count(CONV_A)).toBe(4);
    expect(await h.repository.count(CONV_B)).toBe(4);
    expect(h.backend.calls.every((c) => c.conversationId !== CONV_A)).toBe(true);
    expect(h.stores.session.getState().historyImport.status).toBe('done');
  });

  it('is idempotent against messages already in the repository', async () => {
    const chats = new Map([[CONV_A, archive(CONV_A, 'alice', 5)]]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A]);

    // Simulate the live/seed path having already stored the newest message
    // with its own seq, before the import ever runs.
    const preExisting = { ...chats.get(CONV_A)![4]!, seq: 42 };
    await h.repository.upsert(preExisting, (existing) => existing);

    await service(h).start();

    expect(await h.repository.count(CONV_A)).toBe(5);
    const stored = await h.repository.get(preExisting.id);
    // The existing row's seq must survive the import untouched.
    expect(stored?.seq).toBe(42);
  });

  it('keeps imported disappearing-message metadata as the backend provides it', async () => {
    const pending: Message = {
      ...archive(CONV_A, 'alice', 1)[0]!,
      expiresAfterReadMs: 60_000,
    };
    const chats = new Map([[CONV_A, [pending]]]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A]);

    await service(h).start();

    const stored = await h.repository.get(pending.id);
    expect(stored?.expiresAfterReadMs).toBe(60_000);
    expect(stored?.expiresAt).toBeUndefined();
  });

  it('pauses while catching up and resumes once it clears', async () => {
    const chats = new Map([[CONV_A, archive(CONV_A, 'alice', 2)]]);
    const h = harness({ chats });
    h.stores.session.getState().setCatchingUp(true);
    seedConversations(h.stores, [CONV_A]);

    const run = service(h).start();
    await new Promise((r) => setTimeout(r, 20));
    expect(await h.repository.count(CONV_A)).toBe(0);
    expect(h.stores.session.getState().historyImport.status).not.toBe('done');

    h.stores.session.getState().setCatchingUp(false);
    await run;

    expect(await h.repository.count(CONV_A)).toBe(2);
    expect(h.stores.session.getState().historyImport.status).toBe('done');
  });

  it('does not touch stores other than session (no notifications, no sidebar churn)', async () => {
    const chats = new Map([[CONV_A, archive(CONV_A, 'alice', 3)]]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A]);
    const before = h.stores.conversations.getState();
    let conversationsChanged = 0;
    let messagesChanged = 0;
    h.stores.conversations.subscribe(() => {
      conversationsChanged++;
    });
    h.stores.messages.subscribe(() => {
      messagesChanged++;
    });

    await service(h).start();

    expect(conversationsChanged).toBe(0);
    expect(messagesChanged).toBe(0);
    expect(h.stores.conversations.getState()).toBe(before);
    expect(h.stores.conversations.getState().byId[CONV_A]?.lastActivityAt).toBe(0);
  });

  it('fails, reports the error, then resumes cleanly on retry', async () => {
    const chats = new Map([[CONV_A, archive(CONV_A, 'alice', 2)]]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A]);
    h.backend.failConversation = CONV_A;
    const svc = service(h);

    await svc.start();
    expect(h.stores.session.getState().historyImport.status).toBe('failed');
    expect(h.onErrors.length).toBe(1);

    h.backend.failConversation = null;
    await svc.retry();

    expect(h.stores.session.getState().historyImport.status).toBe('done');
    expect(await h.repository.count(CONV_A)).toBe(2);
  });

  it('reset() clears the persisted record so a cleared repository re-imports', async () => {
    const chats = new Map([[CONV_A, archive(CONV_A, 'alice', 2)]]);
    const h = harness({ chats });
    seedConversations(h.stores, [CONV_A]);

    const first = service(h);
    await first.start();
    expect(h.stores.session.getState().historyImport.status).toBe('done');

    // "Clear history": the repository is wiped and the import is reset so
    // it runs again against the (still-intact) archive.
    await h.repository.clear();
    first.reset();
    expect(h.stores.session.getState().historyImport).toMatchObject({
      status: 'idle',
      imported: 0,
    });

    const second = service(h);
    await second.start();
    expect(h.stores.session.getState().historyImport.status).toBe('done');
    expect(await h.repository.count(CONV_A)).toBe(2);
  });
});
