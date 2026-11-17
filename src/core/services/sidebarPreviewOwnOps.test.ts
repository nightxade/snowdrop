import { describe, expect, it } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

async function setup() {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = () => undefined;
  const receipts = new ReceiptBuffer();
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    receipts,
    onError,
  });
  await sync.start();
  let n = 0;
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    onError,
    newNonce: () => `nonce-${++n}`,
  });
  const history = new HistoryService({ backend, repository, stores, pageSize: 20, onError });
  const id: ConversationId = backend.world.conversationIds.get('books')!;
  await history.open(id);
  const selfId = backend.world.self.id;
  const previewed = () => stores.conversations.getState().lastMessage[id];
  const sendOwn = async (text: string): Promise<Message> => {
    await send.send({ conversationId: id, text, mentionIds: [], attachments: [] });
    const m = previewed()!;
    expect(m.body).toBe(text);
    return stores.messages.getState().windows[id]!.byId[m.id]!;
  };
  const slow = (on = true) => Object.assign(backend, { latencyMs: on ? 100 : 0 });
  return { scheduler, slow, backend, stores, send, sync, id, selfId, previewed, sendOwn };
}

describe('the sidebar preview follows the user’s own edits and deletes', () => {
  it('shows an edit of the newest message at once, and takes it back if the edit fails', async () => {
    const s = await setup();
    const m = await s.sendOwn('one');
    expect(await s.send.edit(s.id, m.id, 'one, edited')).toBe(true);
    expect(s.previewed()?.body).toBe('one, edited');

    s.scheduler.advance(1000);
    s.slow();
    s.backend.failNext();
    const seen: string[] = [];
    s.stores.conversations.subscribe((c) => seen.push(c.lastMessage[s.id]?.body ?? ''));
    const failing = s.send.edit(s.id, m.id, 'one, edited twice');
    await flush();
    s.scheduler.advance(100);
    expect(await failing).toBe(false);
    expect(seen).toEqual(['one, edited twice', 'one, edited']);
    expect(s.previewed()?.body).toBe('one, edited');
  });

  it('shows a delete for everyone of the newest message at once, and takes it back if it fails', async () => {
    const s = await setup();
    const m = await s.sendOwn('one');
    s.slow();
    s.backend.failNext();
    const failing = s.send.deleteForEveryone(s.id, m);
    await flush();
    expect(s.previewed()?.deleted).toBe(true);
    s.scheduler.advance(100);
    expect(await failing).toBe(false);
    expect(s.previewed()?.deleted).not.toBe(true);
    expect(s.previewed()?.body).toBe('one');

    s.slow(false);
    expect(await s.send.deleteForEveryone(s.id, m)).toBe(true);
    expect(s.previewed()?.deleted).toBe(true);
  });

  it('leaves the preview alone when the edited or deleted message is not the newest', async () => {
    const s = await setup();
    const older = await s.sendOwn('older');
    await s.sendOwn('newer');
    expect(await s.send.edit(s.id, older.id, 'older, edited')).toBe(true);
    expect(s.previewed()?.body).toBe('newer');
    expect(await s.send.deleteForEveryone(s.id, older)).toBe(true);
    expect(s.previewed()?.body).toBe('newer');
    expect(s.previewed()?.deleted).not.toBe(true);
  });

  it('does not roll back a preview that has moved on to a newer message', async () => {
    const s = await setup();
    const m = await s.sendOwn('one');
    s.slow();
    s.backend.failNext();
    const failing = s.send.edit(s.id, m.id, 'one, edited');
    await flush();
    s.backend.emit('message', {
      id: messageId(s.selfId, NOW + 500),
      conversationId: s.id,
      authorId: s.selfId,
      sentAt: NOW + 500,
      receivedAt: NOW + 500,
      body: 'from the phone',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'sent',
      kind: 'normal',
    });
    await s.sync.idle();
    s.scheduler.advance(100);
    await failing;
    expect(s.previewed()?.body).toBe('from the phone');
  });

  it('follows an edit made on the user’s other device', async () => {
    const s = await setup();
    const m = await s.sendOwn('one');
    s.backend.emit('messageEdited', {
      conversationId: s.id,
      authorId: s.selfId,
      targetSentAt: m.sentAt,
      body: 'one, from the phone',
      ranges: [],
      editedAt: NOW + 10,
    });
    await s.sync.idle();
    expect(s.previewed()?.body).toBe('one, from the phone');
  });
});
