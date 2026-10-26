import { describe, expect, it, vi } from 'vitest';
import { directConversationId, messageId, parseConversationId, type Message } from '@/core/domain';
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
    expect(world.contacts.size).toBe(30); // 26 people + self + 3 strangers behind the message requests
    expect(groups).toHaveLength(13); // 12 + the group a stranger added the user to
    expect(dms).toHaveLength(11); // 10 + a stranger's first message
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
    expect(has((m) => m.sticker !== undefined && m.attachments.length === 0)).toBe(true);
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

describe('mock message requests', () => {
  const make = async () => {
    const { backend } = setup();
    await backend.connect();
    return backend;
  };

  it('has a stranger’s DM (with a photo) and a stranger-run group, neither saved nor sharing', async () => {
    const backend = await make();
    const { world } = backend;
    const dm = world.conversations.get(world.conversationIds.get('request-dm')!)!;
    const group = world.conversations.get(world.conversationIds.get('request-group')!)!;
    const peer = world.contacts.get(dm.memberIds.find((id) => id !== world.self.id)!)!;
    expect(peer.inContacts).toBeUndefined();
    expect(peer.profileSharing).toBeUndefined();
    expect(world.histories.get(dm.id)?.some((m) => m.attachments.length > 0)).toBe(true);
    expect(
      group.memberIds
        .filter((id) => id !== world.self.id)
        .map((id) => world.contacts.get(id)?.inContacts),
    ).toEqual([undefined, undefined]);
    // Everyone else is saved on the demo phone.
    const known = [...world.contacts.values()].filter(
      (c) => !c.isSelf && c.id !== peer.id && c.inContacts,
    );
    expect(known.length).toBe(26);
  });

  it('accepting shares a profile with the contact and says so; deleting drops the chat', async () => {
    const backend = await make();
    const dm = backend.world.conversationIds.get('request-dm')!;
    const group = backend.world.conversationIds.get('request-group')!;
    const updated: unknown[] = [];
    backend.on('contactUpdated', (c) => updated.push(c));
    await backend.respondToMessageRequest(dm, 'accept');
    expect(updated).toEqual([expect.objectContaining({ profileSharing: true })]);
    expect(
      (await backend.listContacts()).filter((c) => c.profileSharing && !c.inContacts),
    ).toHaveLength(1);
    await backend.respondToMessageRequest(group, 'delete');
    expect((await backend.listConversations()).map((c) => c.id)).not.toContain(group);
    expect(backend.requestResponses.map((r) => r.response)).toEqual(['accept', 'delete']);
    await expect(backend.respondToMessageRequest(group, 'accept')).rejects.toThrow();
  });

  it('blocks and unblocks a contact and a group', async () => {
    const backend = await make();
    const dm = backend.world.conversationIds.get('request-dm')!;
    const group = backend.world.conversationIds.get('request-group')!;
    await backend.setBlocked(dm, true);
    expect((await backend.listContacts()).some((c) => c.blocked)).toBe(true);
    await backend.setBlocked(dm, false);
    expect((await backend.listContacts()).some((c) => c.blocked)).toBe(false);
    await backend.setBlocked(group, true);
    expect((await backend.listConversations()).find((c) => c.id === group)?.blocked).toBe(true);
    await backend.setBlocked(group, false);
    expect(
      (await backend.listConversations()).find((c) => c.id === group)?.blocked,
    ).toBeUndefined();
  });

  it('records read receipts for tests', async () => {
    const backend = await make();
    const dm = backend.world.conversationIds.get('request-dm')!;
    await backend.markRead(dm, [{ authorId: 'a', sentAt: 1 }]);
    expect(backend.readReceiptsSent).toEqual([
      { conversationId: dm, messages: [{ authorId: 'a', sentAt: 1 }] },
    ]);
  });
});

describe('mock stickers', () => {
  it('lists a few installed packs whose stickers render without a transport', async () => {
    const { backend } = setup();
    await backend.connect();
    const packs = await backend.listStickerPacks();
    expect(packs.length).toBeGreaterThanOrEqual(2);
    for (const pack of packs) {
      expect(pack.packId).toMatch(/^[\da-f]+$/u);
      expect(pack.title).not.toBe('');
      expect(pack.stickers.length).toBeGreaterThan(0);
      expect(pack.cover.url).toMatch(/^data:image\/svg\+xml/u);
      for (const s of pack.stickers) expect(s.url).toMatch(/^data:image\/svg\+xml/u);
    }
    expect(new Set(packs.map((p) => p.packId)).size).toBe(packs.length);
  });

  it('sends a sticker as a normal message with no text or attachments', async () => {
    const { backend } = setup();
    await backend.connect();
    const conv = backend.world.conversationIds.get('dm-lucia')!;
    const [pack] = await backend.listStickerPacks();
    const first = pack!.stickers[0]!;
    const sticker = { packId: pack!.packId, ...first };
    const events = collect(backend, 'message');
    const { sentAt } = await backend.send({
      conversationId: conv,
      body: '',
      ranges: [],
      sticker,
    });
    const page = await backend.fetchHistory(conv, { limit: 5 });
    expect(page.messages.find((m) => m.sentAt === sentAt)).toMatchObject({
      body: '',
      attachments: [],
      sticker,
    });
    expect(events).toHaveLength(0); // our own send isn't echoed as incoming
  });
});

describe('mock sticker pack install and delivered custom emoji', () => {
  const sentMessages = (backend: MockBackend) => [...backend.world.histories.values()].flat();

  it('has an uninstalled pack seen in a received sticker, shown by the pack dialog only', async () => {
    const { backend } = setup();
    await backend.connect();
    const sticker = sentMessages(backend).find(
      (m) => m.sticker && m.sticker.packId === '3c0ffee5ab1e4d2790a8d1f06b7c4e19',
    )?.sticker;
    expect(sticker).toBeDefined();
    const details = await backend.getStickerPack(sticker!);
    expect(details).toMatchObject({ title: 'Winter Folk', installed: false });
    expect(details.stickers.length).toBeGreaterThan(1);
    expect((await backend.listStickerPacks()).map((p) => p.title)).not.toContain('Winter Folk');
    expect(backend.supportsStickerPackInstall()).toBe(true);
  });

  it('installs it: the picker lists the pack afterwards and the dialog says installed', async () => {
    const { backend } = setup();
    await backend.connect();
    const sticker = { packId: '3c0ffee5ab1e4d2790a8d1f06b7c4e19', stickerId: 0 };
    await backend.installStickerPack(sticker);
    expect((await backend.getStickerPack(sticker)).installed).toBe(true);
    expect((await backend.listStickerPacks()).map((p) => p.title)).toContain('Winter Folk');
  });

  it('fails an install on demand and stays uninstalled, and rejects an unknown pack', async () => {
    const { backend } = setup();
    await backend.connect();
    const sticker = { packId: '3c0ffee5ab1e4d2790a8d1f06b7c4e19', stickerId: 0 };
    backend.failNext();
    await expect(backend.installStickerPack(sticker)).rejects.toThrow();
    expect((await backend.getStickerPack(sticker)).installed).toBe(false);
    await expect(backend.installStickerPack({ packId: 'ff00', stickerId: 0 })).rejects.toThrow();
    await expect(backend.getStickerPack({ packId: 'ff00', stickerId: 0 })).rejects.toThrow();
  });

  it('delivers two different emoji under one name, readable as PNG bytes', async () => {
    const { backend } = setup();
    await backend.connect();
    const delivered = sentMessages(backend).flatMap((m) =>
      (m.customEmoji ?? []).map((d) => ({ conversationId: m.conversationId, d })),
    );
    expect(delivered.map((x) => x.d.name)).toEqual(['partyblob', 'partyblob']);
    const urls = delivered.map((x) => x.d.attachment.url);
    expect(new Set(urls).size).toBe(2);
    for (const { conversationId, d } of delivered) {
      const blob = await backend.readAttachmentBlob(conversationId, d.attachment, {
        maxBytes: 256 * 1024,
      });
      expect(blob.type).toBe('image/png');
      expect(blob.size).toBeGreaterThan(0);
    }
    const [first] = delivered;
    await expect(
      backend.readAttachmentBlob(first!.conversationId, first!.d.attachment, { maxBytes: 4 }),
    ).rejects.toThrow();
  });
});

describe('mock attachment bytes', () => {
  it('decodes the demo’s percent-encoded images as well as base64 ones', async () => {
    const { backend } = setup();
    await backend.connect();
    const id = [...backend.world.conversations.keys()][0]!;
    const svg = await backend.readAttachmentBlob(id, {
      id: 'a',
      contentType: 'image/svg+xml',
      url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg a="1"/>')}`,
    });
    expect(await svg.text()).toBe('<svg a="1"/>');
    const png = await backend.readAttachmentBlob(id, {
      id: 'b',
      contentType: 'image/png',
      url: 'data:image/png;base64,aGk=',
    });
    expect(await png.text()).toBe('hi');
  });
});

describe('mock recipient lookup', () => {
  it('finds a person by number, a stranger in the demo directory, and not anyone else', async () => {
    const { backend } = setup();
    await backend.connect();
    const person = [...backend.world.contacts.values()].find((c) => c.number && !c.isSelf)!;
    expect(await backend.lookupRecipient({ kind: 'phone', e164: person.number! })).toMatchObject({
      status: 'found',
      id: person.id,
    });
    const stranger = await backend.lookupRecipient({ kind: 'phone', e164: '+12025550190' });
    const named = await backend.lookupRecipient({ kind: 'username', username: 'demo.42' });
    expect(stranger.status).toBe('found');
    expect(named.status).toBe('found');
    expect(await backend.lookupRecipient({ kind: 'phone', e164: '+12025550190' })).toEqual(
      stranger,
    );
    expect(await backend.lookupRecipient({ kind: 'phone', e164: '+442071234567' })).toEqual({
      status: 'not-registered',
    });
    expect(await backend.lookupRecipient({ kind: 'username', username: 'nobody.42' })).toEqual({
      status: 'not-registered',
    });
    backend.lookupRateLimited = true;
    expect(await backend.lookupRecipient({ kind: 'phone', e164: '+12025550190' })).toEqual({
      status: 'rate-limited',
    });
  });

  it('starts a DM with a found stranger on the first send, and only then', async () => {
    const { backend } = setup();
    await backend.connect();
    const found = await backend.lookupRecipient({ kind: 'phone', e164: '+12025550190' });
    if (found.status !== 'found') throw new Error('expected a match');
    const id = directConversationId(found.id);
    expect((await backend.listConversations()).map((c) => c.id)).not.toContain(id);
    const updates = collect(backend, 'conversationUpdated');
    await backend.send({ conversationId: id, body: 'hello', ranges: [] });
    expect((await backend.listConversations()).map((c) => c.id)).toContain(id);
    expect(updates.map((c) => c.id)).toEqual([id]);
    await expect(
      backend.send({ conversationId: directConversationId('nobody'), body: 'x', ranges: [] }),
    ).rejects.toThrow();
  });
});
