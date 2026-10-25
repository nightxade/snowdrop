import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { addLogSink, type LogLevel } from '@/core/lib/log';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { MessageRequestService } from './MessageRequestService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

const incoming = (
  conversationId: ConversationId,
  authorId: string,
  sentAt: number,
  extra: Partial<Message> = {},
): Message => ({
  id: messageId(authorId, sentAt),
  conversationId,
  authorId,
  sentAt,
  receivedAt: NOW,
  body: 'hello',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
  ...extra,
});

async function setup(options: { readSync?: boolean; wireReply?: boolean } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.readSyncSupported = options.readSync ?? true;
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
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
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    onError,
    ...(options.wireReply === false
      ? {}
      : { readConversation: (id: ConversationId) => sync.markConversationRead(id) }),
  });
  const requests = new MessageRequestService({
    backend,
    repository,
    stores,
    sync,
    clock: scheduler,
    onError,
  });
  const conv = backend.world.conversationIds.get('crux')!;
  const request = backend.world.conversationIds.get('request-dm')!;
  const selfId = backend.world.self.id;
  const peerOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const markRead = vi.spyOn(backend, 'markRead');
  return {
    backend,
    repository,
    stores,
    sync,
    send,
    requests,
    onError,
    conv,
    request,
    peerOf,
    markRead,
  };
}

describe('read sync: reading always reaches the user’s own devices', () => {
  it('opening a chat with unread messages acks exactly the unread ones', async () => {
    const { backend, stores, sync, conv, peerOf, markRead } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    backend.deliver(incoming(conv, peerOf(conv), NOW + 2));
    await sync.idle();
    expect(stores.conversations.getState().unread[conv]?.count).toBeGreaterThanOrEqual(2);
    const before = stores.conversations.getState().unread[conv]!.count;
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(1);
    const refs = markRead.mock.calls[0]![1];
    expect(refs).toHaveLength(before);
    expect(refs).toContainEqual({ authorId: peerOf(conv), sentAt: NOW + 2 });
    expect(markRead.mock.calls[0]![2]).toBeUndefined();
  });

  it('reading clears a hand-set unread flag, with nothing sent when nothing was unread', async () => {
    const { stores, sync, conv, markRead } = await setup();
    await sync.markConversationRead(conv);
    markRead.mockClear();
    stores.local.getState().setMarkedUnread(conv, true);
    await sync.markConversationRead(conv);
    expect(stores.local.getState().conversations[conv]?.markedUnread).toBeUndefined();
    expect(markRead).not.toHaveBeenCalled();
  });

  it('a message read on arrival while viewing is acked', async () => {
    const { backend, stores, sync, conv, peerOf, markRead } = await setup();
    await sync.markConversationRead(conv);
    markRead.mockClear();
    stores.ui.getState().setWindowFocused(true);
    stores.ui.getState().selectConversation(conv);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 9));
    await sync.idle();
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]![1]).toEqual([{ authorId: peerOf(conv), sentAt: NOW + 9 }]);
  });

  it('replying to a chat with unread messages acks them (it used to only move the cursor)', async () => {
    const { backend, stores, sync, send, conv, peerOf, markRead } = await setup();
    stores.ui.getState().setWindowFocused(false);
    backend.deliver(incoming(conv, peerOf(conv), NOW + 1));
    await sync.idle();
    expect(stores.conversations.getState().unread[conv]?.count).toBeGreaterThan(0);
    await send.send({ conversationId: conv, text: 'on it', mentionIds: [], attachments: [] });
    const acked = markRead.mock.calls.flatMap((c) => c[1]);
    expect(acked).toContainEqual({ authorId: peerOf(conv), sentAt: NOW + 1 });
    expect(stores.conversations.getState().unread[conv]?.count).toBe(0);
  });

  it('receipts off: sync-only, and an old signal-cli sends nothing at all', async () => {
    const off = await setup();
    off.stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    await off.sync.markConversationRead(off.conv);
    expect(off.markRead).toHaveBeenCalledTimes(1);
    expect(off.markRead.mock.calls[0]![2]).toEqual({ syncOnly: true });

    const old = await setup({ readSync: false });
    old.stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    await old.sync.markConversationRead(old.conv);
    expect(old.markRead).not.toHaveBeenCalled();
    expect(old.backend.readReceiptsSent).toEqual([]);
  });

  it('a request is synced only; accepting later sends the receipt without re-syncing when receipts are off', async () => {
    const { stores, sync, requests, request, markRead } = await setup();
    stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    await sync.markConversationRead(request);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]![2]).toEqual({ syncOnly: true });
    await requests.accept(request);
    // Receipts are off: accepting has nothing new to send.
    expect(markRead).toHaveBeenCalledTimes(1);
  });

  it('an old signal-cli still gets the receipt for an accepted chat', async () => {
    const { sync, conv, markRead } = await setup({ readSync: false });
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]![2]).toBeUndefined();
  });
});

describe('read sync: failures are visible', () => {
  function captureLog() {
    const lines: { level: LogLevel; message: string }[] = [];
    const off = addLogSink({
      write: (level, scope, message) => {
        if (scope === 'sync' && message.startsWith('read sync sent'))
          lines.push({ level, message });
      },
    });
    return { lines, off };
  }
  const json = (message: string) => JSON.parse(message.slice('read sync sent '.length)) as unknown;

  it('logs a successful sync at info with counts and types only', async () => {
    const { backend, sync, conv } = await setup();
    backend.readSummary = { receipt: 'success', sync: 'success' };
    const { lines, off } = captureLog();
    await sync.markConversationRead(conv);
    off();
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('info');
    const fields = json(lines[0]!.message) as Record<string, unknown>;
    expect(Object.keys(fields).sort()).toEqual(['mode', 'n', 'receipt', 'sync']);
    expect(fields).toMatchObject({ mode: 'receipt', receipt: 'success', sync: 'success' });
    expect(typeof fields.n).toBe('number');
  });

  it('an older backend that cannot say is still info', async () => {
    const { sync, conv } = await setup();
    const { lines, off } = captureLog();
    await sync.markConversationRead(conv);
    off();
    expect(lines[0]!.level).toBe('info');
    expect(json(lines[0]!.message)).toMatchObject({ receipt: 'unreported', sync: 'unreported' });
  });

  it('warns when the sync failed', async () => {
    const { backend, stores, sync, conv } = await setup();
    stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    backend.readSummary = { receipt: 'none', sync: 'network' };
    const { lines, off } = captureLog();
    await sync.markConversationRead(conv);
    off();
    expect(lines[0]!.level).toBe('warn');
    expect(json(lines[0]!.message)).toMatchObject({ mode: 'sync-only', sync: 'network' });
  });

  it.each([
    [{ receipt: 'unregistered', sync: 'success' }],
    [{ receipt: 'success', sync: 'skipped-no-aci' }],
  ])('warns for %j', async (summary) => {
    const { backend, sync, conv } = await setup();
    backend.readSummary = summary;
    const { lines, off } = captureLog();
    await sync.markConversationRead(conv);
    off();
    expect(lines[0]!.level).toBe('warn');
    expect(json(lines[0]!.message)).toMatchObject(summary);
  });
});
