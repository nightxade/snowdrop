import { describe, expect, it, vi } from 'vitest';
import { messageId, parseConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import type { BackendEvents } from '../types';
import { MockBackend } from './MockBackend';
import { buildWorld } from './world';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler });
  return { scheduler, backend };
}

function collect<E extends keyof BackendEvents>(backend: MockBackend, event: E) {
  const events: BackendEvents[E][] = [];
  backend.on(event, (p) => events.push(p));
  return events;
}

describe('mock world', () => {
  const world = buildWorld({ seed: 42, now: NOW });
  const all = [...world.histories.values()].flat();
  const groups = [...world.conversations.values()].filter((c) => c.kind === 'group');
  const dms = [...world.conversations.values()].filter((c) => c.kind === 'direct');

  it('is deterministic for a seed and time', () => {
    const again = buildWorld({ seed: 42, now: NOW });
    expect([...again.histories.values()].flat().map((m) => m.id)).toEqual(all.map((m) => m.id));
    const other = buildWorld({ seed: 43, now: NOW });
    expect(other.self.id).not.toBe(world.self.id);
  });

  it('has the documented shape', () => {
    expect(world.contacts.size).toBe(27); // 26 people + self
    expect(groups).toHaveLength(12);
    expect(dms).toHaveLength(10);
    expect(world.defaultSpaces.map((s) => s.name)).toEqual(['Work', 'Climbing Club', 'Family']);
    for (const c of world.conversations.values()) {
      expect(parseConversationId(c.id)?.kind).toBe(c.kind);
      expect(c.memberIds).toContain(world.self.id);
    }
  });

  it('contains every feature the UI needs to exercise', () => {
    const has = (pred: (m: Message) => boolean) => all.some(pred);
    expect(has((m) => m.quote !== undefined)).toBe(true);
    expect(has((m) => m.reactions.length > 0)).toBe(true);
    expect(has((m) => (m.edits ?? 0) > 0)).toBe(true);
    expect(has((m) => m.deleted === true)).toBe(true);
    expect(has((m) => m.ranges.some((r) => r.mentionId === world.self.id))).toBe(true);
    for (const style of ['bold', 'italic', 'strikethrough', 'monospace', 'spoiler'] as const) {
      expect(has((m) => m.ranges.some((r) => r.style === style))).toBe(true);
    }
    expect(has((m) => m.attachments.some((a) => a.url?.startsWith('data:image/svg+xml')))).toBe(
      true,
    );
    expect(has((m) => m.attachments.some((a) => !a.contentType.startsWith('image/')))).toBe(true);
    expect(has((m) => m.kind === 'system')).toBe(true);
    expect(has((m) => m.body.length > 400)).toBe(true);
    const days = new Set(all.map((m) => new Date(m.sentAt).toISOString().slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(5);
  });

  it('keeps histories sorted, unique and in the past', () => {
    const ids = new Set<string>();
    for (const history of world.histories.values()) {
      for (let i = 0; i < history.length; i++) {
        const m = history[i]!;
        expect(m.sentAt).toBeLessThan(NOW);
        if (i > 0) expect(m.sentAt).toBeGreaterThanOrEqual(history[i - 1]!.sentAt);
        expect(m.id).toBe(messageId(m.authorId, m.sentAt));
        expect(ids.has(m.id)).toBe(false);
        ids.add(m.id);
      }
    }
  });

  it('leaves some conversations unread', () => {
    let unreadConvs = 0;
    for (const [id, history] of world.histories) {
      const cursor = world.readUpTo.get(id)!;
      if (history.some((m) => m.sentAt > cursor && m.authorId !== world.self.id)) unreadConvs++;
    }
    expect(unreadConvs).toBeGreaterThanOrEqual(5);
  });

  it('keeps identities stable regardless of the current time', () => {
    const later = buildWorld({ seed: 42, now: NOW + 3 * 86_400_000 + 12_345 });
    expect([...later.conversations.keys()]).toEqual([...world.conversations.keys()]);
    expect([...later.contacts.keys()]).toEqual([...world.contacts.keys()]);
  });

  it('anchors scripted messages a day earlier when "today" is too young', () => {
    const early = buildWorld({ seed: 42, now: Date.UTC(2026, 8, 30, 1, 0) });
    for (const history of early.histories.values()) {
      for (const m of history) expect(m.sentAt).toBeLessThan(Date.UTC(2026, 8, 30, 1, 0));
    }
  });
});

describe('MockBackend', () => {
  it('connects and reports status transitions', async () => {
    const { backend } = setup();
    const statuses = collect(backend, 'status');
    expect(backend.getStatus()).toBe('offline');
    await backend.connect();
    expect(statuses).toEqual(['connecting', 'online']);
    await backend.disconnect();
    expect(backend.getStatus()).toBe('offline');
  });

  it('pages history newest-first with readUpTo on the first page', async () => {
    const { backend } = setup();
    const conv = [...backend.world.conversations.keys()][0]!;
    const full = backend.world.histories.get(conv)!;
    const first = await backend.fetchHistory(conv, { limit: 10 });
    expect(first.messages).toEqual(full.slice(-10));
    expect(first.readUpTo).toBeDefined();
    expect(first.hasMoreBefore).toBe(full.length > 10);
    const second = await backend.fetchHistory(conv, {
      limit: 10,
      before: first.messages[0]!.sentAt,
    });
    expect(second.messages).toEqual(full.slice(-20, -10));
    expect(second.readUpTo).toBeUndefined();
  });

  it('returns copies, not world internals', async () => {
    const { backend } = setup();
    const [conv] = await backend.listConversations();
    conv!.title = 'mutated';
    expect(backend.world.conversations.get(conv!.id)?.title).not.toBe('mutated');
  });

  it('sends with a unique timestamp and emits receipts', async () => {
    const { backend, scheduler } = setup();
    await backend.connect();
    const receipts = collect(backend, 'receipt');
    const conv = backend.world.conversationIds.get('orchard-eng')!;
    const a = await backend.send({ conversationId: conv, body: 'hi', ranges: [] });
    const b = await backend.send({ conversationId: conv, body: 'again', ranges: [] });
    expect(a.sentAt).toBe(NOW);
    expect(b.sentAt).toBe(NOW + 1);
    expect(backend.world.histories.get(conv)!.at(-1)?.body).toBe('again');
    scheduler.advance(10_000);
    expect(receipts.map((r) => r.type).sort()).toEqual(['delivered', 'delivered', 'read', 'read']);
  });

  it('rejects when offline and on injected failures', async () => {
    const { backend } = setup();
    const conv = backend.world.conversationIds.get('orchard-eng')!;
    await expect(backend.send({ conversationId: conv, body: 'x', ranges: [] })).rejects.toThrow(
      /Not connected/u,
    );
    await backend.connect();
    backend.failNext();
    await expect(backend.send({ conversationId: conv, body: 'x', ranges: [] })).rejects.toThrow(
      /Simulated/u,
    );
    await expect(
      backend.send({ conversationId: conv, body: 'x', ranges: [] }),
    ).resolves.toBeDefined();
  });

  it('edits, reacts and deletes own messages', async () => {
    const { backend } = setup();
    await backend.connect();
    const conv = backend.world.conversationIds.get('dm-ines')!;
    const { sentAt } = await backend.send({ conversationId: conv, body: 'tpyo', ranges: [] });
    await backend.edit({ conversationId: conv, targetSentAt: sentAt, body: 'typo', ranges: [] });
    await backend.react({
      conversationId: conv,
      targetAuthorId: backend.world.self.id,
      targetSentAt: sentAt,
      emoji: '👍',
      remove: false,
    });
    let msg = backend.world.histories.get(conv)!.find((m) => m.sentAt === sentAt)!;
    expect(msg).toMatchObject({ body: 'typo', edits: 1 });
    expect(msg.reactions).toHaveLength(1);
    await backend.deleteForEveryone(conv, sentAt);
    msg = backend.world.histories.get(conv)!.find((m) => m.sentAt === sentAt)!;
    expect(msg.deleted).toBe(true);
  });

  it('pins messages and lets admins delete others’ messages', async () => {
    const { backend } = setup();
    await backend.connect();
    const conv = backend.world.conversationIds.get('orchard-eng')!;
    const target = backend.world.histories
      .get(conv)!
      .find((m) => m.authorId !== backend.world.self.id && !m.deleted)!;
    const ref = { authorId: target.authorId, sentAt: target.sentAt };
    await backend.pinMessage({
      conversationId: conv,
      targetAuthorId: ref.authorId,
      targetSentAt: ref.sentAt,
      pin: true,
    });
    expect(backend.world.histories.get(conv)!.find((m) => m.id === target.id)?.pinned).toBe(true);
    await backend.adminDelete(conv, ref);
    expect(backend.world.histories.get(conv)!.find((m) => m.id === target.id)).toMatchObject({
      deleted: true,
      deletedBy: backend.world.self.id,
    });
    // Not an admin of this group.
    const books = backend.world.conversationIds.get('books')!;
    const other = backend.world.histories
      .get(books)!
      .find((m) => m.authorId !== backend.world.self.id)!;
    await expect(
      backend.adminDelete(books, { authorId: other.authorId, sentAt: other.sentAt }),
    ).rejects.toThrow(/admin/u);
  });

  it('simulates liveliness on the injected scheduler and stops cleanly', async () => {
    const { backend, scheduler } = setup();
    await backend.connect();
    const messages = collect(backend, 'message');
    const typing = collect(backend, 'typing');
    const reactions = collect(backend, 'reaction');
    backend.liveliness.start();
    scheduler.advance(120_000);
    expect(messages.length).toBeGreaterThan(3);
    expect(typing.length).toBeGreaterThan(3);
    expect(messages.every((m) => backend.world.lively.includes(m.conversationId))).toBe(true);
    expect(messages.length + reactions.length).toBeGreaterThan(8);
    // Every "typing: true" is eventually followed by "typing: false" for that author.
    backend.liveliness.stop();
    expect(scheduler.pending).toBe(0);
    const count = messages.length;
    scheduler.advance(120_000);
    expect(messages.length).toBe(count);
  });

  it('replies in DMs while lively', async () => {
    const { backend, scheduler } = setup();
    await backend.connect();
    backend.liveliness.start();
    const messages = collect(backend, 'message');
    const conv = backend.world.conversationIds.get('dm-lucia')!;
    await backend.send({ conversationId: conv, body: 'climbing?', ranges: [] });
    scheduler.advance(4_000);
    expect(messages.some((m) => m.conversationId === conv)).toBe(true);
    backend.liveliness.stop();
  });

  it('updates conversations and emits the change', async () => {
    const { backend } = setup();
    await backend.connect();
    const fn = vi.fn();
    backend.on('conversationUpdated', fn);
    const conv = backend.world.conversationIds.get('books')!;
    await backend.updateConversation(conv, { title: 'Book Nook 📚' });
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ title: 'Book Nook 📚' }));
  });

  it('simulates attachment backfill: a pending event, then ready after a delay', async () => {
    const { backend, scheduler } = setup();
    await backend.connect();
    expect(backend.supportsAttachmentBackfill()).toBe(true);
    const conv = backend.world.conversationIds.get('dm-lucia')!;
    const events = collect(backend, 'attachmentBackfill');

    await backend.requestAttachmentBackfill(conv, 'author-1', 1_000, ['att-1', 'att-2']);
    expect(events).toEqual([
      {
        targetAuthorId: 'author-1',
        targetSentAt: 1_000,
        status: 'pending',
        attachmentIds: ['att-1', 'att-2'],
      },
    ]);

    scheduler.advance(1_500);
    expect(events).toEqual([
      {
        targetAuthorId: 'author-1',
        targetSentAt: 1_000,
        status: 'pending',
        attachmentIds: ['att-1', 'att-2'],
      },
      {
        targetAuthorId: 'author-1',
        targetSentAt: 1_000,
        status: 'ready',
        attachmentIds: ['att-1', 'att-2'],
      },
    ]);
  });
});
