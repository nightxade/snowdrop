import { describe, expect, it } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { messageId, pendingMessageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { settlePreviewAfterSend } from './sidebarPreview';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

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
  Object.assign(backend, { latencyMs: 100 });
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
  const id = backend.world.conversationIds.get('books')!;
  const selfId = backend.world.self.id;
  const other = backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const shown: string[] = [];
  stores.conversations.subscribe((s) => {
    const body = s.lastMessage[id]?.body ?? '';
    if (shown.at(-1) !== body) shown.push(body);
  });
  return { scheduler, backend, repository, stores, sync, send, history, id, selfId, other, shown };
}
const msg = (id: ConversationId, authorId: string, sentAt: number, body: string): Message => ({
  id: messageId(authorId, sentAt),
  conversationId: id,
  authorId,
  sentAt,
  receivedAt: NOW,
  body,
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
});

describe('the sidebar preview of a chat with a send in flight', () => {
  const draft = (id: ConversationId, text: string) => ({
    conversationId: id,
    text,
    mentionIds: [],
    attachments: [],
  });

  it('follows a sync echo that beats the acknowledgement without ever going back', async () => {
    const s = await setup();
    await s.history.open(s.id);
    s.shown.length = 0;
    const p = s.send.send(draft(s.id, 'two'));
    await flush();
    s.scheduler.advance(100);
    s.backend.emit('message', msg(s.id, s.selfId, NOW + 100, 'two'));
    await s.sync.idle();
    await p;
    expect(s.shown).toEqual(['I listened to the audiobook, the narrator was great', 'two']);
  });

  it('keeps a reply that arrived during the send as the newest, never showing the older send again', async () => {
    const s = await setup();
    await s.history.open(s.id);
    s.shown.length = 0;
    const p = s.send.send(draft(s.id, 'two'));
    await flush();
    s.backend.emit('message', msg(s.id, s.other, NOW + 50, 'reply'));
    await s.sync.idle();
    s.scheduler.advance(100);
    s.backend.emit('message', msg(s.id, s.selfId, NOW + 100, 'two'));
    await s.sync.idle();
    await p;
    await s.sync.idle();
    expect(s.shown).toEqual([
      'I listened to the audiobook, the narrator was great',
      'two',
      'reply',
    ]);
    expect(s.stores.conversations.getState().lastMessage[s.id]?.body).toBe('reply');
  });

  it('still moves to a message sent from the phone while a failed send sits in the chat', async () => {
    const s = await setup();
    await s.history.open(s.id);
    s.stores.messages.getState().appendLive({
      ...msg(s.id, s.selfId, NOW + 10, 'never went out'),
      id: pendingMessageId('nonce-failed'),
      status: 'failed',
    });
    s.backend.emit('message', msg(s.id, s.selfId, NOW + 200, 'from the phone'));
    await s.sync.idle();
    expect(s.stores.conversations.getState().lastMessage[s.id]?.body).toBe('from the phone');
  });

  it('settlePreviewAfterSend hands the preview to the stored newest, and leaves a moved-on one alone', async () => {
    const s = await setup();
    const sent = msg(s.id, s.selfId, NOW + 100, 'two');
    const reply = msg(s.id, s.other, NOW + 50, 'reply');
    await s.repository.upsertMany([sent, reply], { backfill: false, merge: (e) => e });
    const stored = (await s.repository.get(sent.id))!;
    const store = s.stores.conversations;
    // The sent message was stored first (lower seq), yet the preview holds it.
    store.setState({ lastMessage: { ...store.getState().lastMessage, [s.id]: stored } });
    await settlePreviewAfterSend(store, s.repository, stored);
    expect(store.getState().lastMessage[s.id]?.body).toBe('reply');
    // Already moved on to something else: untouched.
    const other = msg(s.id, s.other, NOW + 60, 'later');
    store.setState({ lastMessage: { ...store.getState().lastMessage, [s.id]: other } });
    await settlePreviewAfterSend(store, s.repository, stored);
    expect(store.getState().lastMessage[s.id]?.body).toBe('later');
  });
});
