import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import type { PhonePrivacyPatch, PhonePrivacySettings } from '@/core/backend';
import { messageId, type ConversationId, type Message } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const UNKNOWN: PhonePrivacySettings = {
  readReceipts: null,
  typingIndicators: null,
  linkPreviews: null,
  unidentifiedDeliveryIndicators: null,
};

/** A deferred value the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * The demo backend dressed up as a patched signal-cli that reports the
 * phone's privacy settings: `phone` is what `readPhonePrivacy` answers with
 * (a function, so a test can hold the answer back or fail it).
 */
async function setup(
  options: {
    phone?: () => Promise<PhonePrivacySettings>;
    supported?: boolean;
    start?: boolean;
  } = {},
) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  const state = { values: { ...UNKNOWN } };
  const reads = vi.fn(options.phone ?? (() => Promise.resolve({ ...state.values })));
  const updates = vi.fn((_patch: PhonePrivacyPatch) => Promise.resolve());
  if (options.supported !== false) {
    Object.assign(backend, {
      supportsPhonePrivacy: () => true,
      readPhonePrivacy: reads,
      updatePhonePrivacy: updates,
    });
  }
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
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    onError,
  });
  const started = options.start === false ? null : sync.start();
  if (started) await started;
  const conv = (key: string) => backend.world.conversationIds.get(key)!;
  const unread = (id: ConversationId, author: string, sentAt: number): Message => ({
    id: messageId(author, sentAt),
    conversationId: id,
    authorId: author,
    sentAt,
    receivedAt: NOW,
    body: 'hello',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'read',
    kind: 'normal',
  });
  return {
    scheduler,
    backend,
    stores,
    sync,
    send,
    state,
    reads,
    updates,
    onError,
    conv,
    unread,
    started,
  };
}

const phoneState = (stores: ReturnType<typeof createStores>) =>
  stores.session.getState().phonePrivacy;

describe('phone privacy: where the effective settings come from', () => {
  it('uses Snowdrop’s own settings when the backend cannot report the phone’s', async () => {
    const { stores, backend, sync, conv, send } = await setup({ supported: false });
    expect(phoneState(stores).status).toBe('unsupported');
    stores.settings
      .getState()
      .update('behaviour', { sendReadReceipts: false, sendTypingIndicators: true });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    // No receipt, but the read still syncs to the phone.
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[2]).toEqual({ syncOnly: true });
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(1);
  });

  it('lets the phone’s values override the local ones, both ways', async () => {
    const { stores, backend, sync, conv, send, state } = await setup({ start: false });
    state.values = { ...UNKNOWN, readReceipts: false, typingIndicators: false };
    await sync.start();
    expect(phoneState(stores).status).toBe('ready');
    // Local says on; the phone says off.
    stores.settings
      .getState()
      .update('behaviour', { sendReadReceipts: true, sendTypingIndicators: true });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[2]).toEqual({ syncOnly: true });
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(0);

    // Local says off; the phone says on.
    state.values = { ...UNKNOWN, readReceipts: true, typingIndicators: true };
    backend.emit('phonePrivacyChanged', undefined);
    await flush();
    stores.settings
      .getState()
      .update('behaviour', { sendReadReceipts: false, sendTypingIndicators: false });
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(1);
    await sync.markConversationRead(conv('books'));
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('falls back to the local setting for a value the phone has not sent', async () => {
    const { stores, backend, sync, conv, state } = await setup({ start: false });
    state.values = { ...UNKNOWN, typingIndicators: true };
    await sync.start();
    stores.settings.getState().update('behaviour', { sendReadReceipts: false });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[2]).toEqual({ syncOnly: true });
    stores.settings.getState().update('behaviour', { sendReadReceipts: true });
    await sync.markConversationRead(conv('books'));
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls[1]?.[2]).toBeUndefined();
  });

  it('applies a change that arrives mid-session', async () => {
    const { stores, backend, sync, conv, send, state } = await setup({ start: false });
    state.values = { ...UNKNOWN, typingIndicators: true };
    await sync.start();
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(1);

    // The user turns typing indicators off on the phone.
    state.values = { ...UNKNOWN, typingIndicators: false };
    backend.emit('phonePrivacyChanged', undefined);
    await flush();
    expect(phoneState(stores).values.typingIndicators).toBe(false);
    await send.setTyping(conv('dm-ines'), false);
    await send.setTyping(conv('crux'), true);
    expect(backend.typingSent.filter((t) => t.typing)).toHaveLength(1);
  });
});

describe('phone privacy: nothing goes out before the first read', () => {
  it('holds typing indicators while the first read is outstanding', async () => {
    const answer = deferred<PhonePrivacySettings>();
    const { stores, backend, sync, send, conv } = await setup({
      phone: () => answer.promise,
      start: false,
    });
    const starting = sync.start();
    await flush();
    expect(phoneState(stores).status).toBe('pending');
    stores.settings.getState().update('behaviour', { sendTypingIndicators: true });
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(0);

    answer.resolve({ ...UNKNOWN, typingIndicators: true });
    await starting;
    expect(phoneState(stores).status).toBe('ready');
    await send.setTyping(conv('dm-ines'), true);
    expect(backend.typingSent).toHaveLength(1);
  });

  it('holds read receipts until the read finishes, then sends them if the phone allows', async () => {
    let attempt = 0;
    const { stores, backend, sync, conv, scheduler } = await setup({
      phone: () => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('daemon not ready'));
        return Promise.resolve({ ...UNKNOWN, readReceipts: true });
      },
    });
    // The first read failed: still pending, so nothing is sent yet.
    expect(phoneState(stores).status).toBe('pending');
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    expect(markRead).not.toHaveBeenCalled();

    scheduler.advance(3_000);
    await flush();
    expect(phoneState(stores).status).toBe('ready');
    expect(markRead).toHaveBeenCalledOnce();
  });

  it('drops held read receipts when the phone turns out to have them off', async () => {
    let attempt = 0;
    const { stores, backend, sync, conv, scheduler } = await setup({
      phone: () => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error('daemon not ready'));
        return Promise.resolve({ ...UNKNOWN, readReceipts: false });
      },
    });
    stores.settings.getState().update('behaviour', { sendReadReceipts: true });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    scheduler.advance(3_000);
    await flush();
    expect(phoneState(stores).status).toBe('ready');
    // Held while unknown; with receipts off the held read becomes a sync-only one.
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[2]).toEqual({ syncOnly: true });
  });

  it('holds the read receipt of a conversation read while the first read is outstanding', async () => {
    // Start normally (unknown values), then make the next read slow: a reconnect.
    const { stores, backend, sync, conv } = await setup();
    const answer = deferred<PhonePrivacySettings>();
    Object.assign(backend, { readPhonePrivacy: () => answer.promise });
    stores.session.getState().setPhonePrivacy({ status: 'pending', values: UNKNOWN });
    stores.settings.getState().update('behaviour', { sendReadReceipts: true });
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv('crux'));
    expect(stores.conversations.getState().unread[conv('crux')]?.count).toBe(0);
    expect(markRead).not.toHaveBeenCalled();
    // The answer arrives through the store the way a refresh would set it.
    stores.session
      .getState()
      .setPhonePrivacy({ status: 'ready', values: { ...UNKNOWN, readReceipts: true } });
    expect(markRead).toHaveBeenCalledOnce();
    answer.resolve({ ...UNKNOWN });
  });
});

describe('phone privacy: changing a setting from Snowdrop', () => {
  it('applies at once, asks the backend, and keeps the value', async () => {
    const { stores, sync, updates, state } = await setup({ start: false });
    state.values = { ...UNKNOWN, readReceipts: true, linkPreviews: true };
    await sync.start();
    await expect(sync.updatePhonePrivacy({ readReceipts: false })).resolves.toBe(true);
    expect(updates).toHaveBeenCalledWith({ readReceipts: false });
    expect(phoneState(stores).values).toMatchObject({ readReceipts: false, linkPreviews: true });
  });

  it('puts the old value back when the backend refuses', async () => {
    const { stores, sync, updates, onError, state } = await setup({ start: false });
    state.values = { ...UNKNOWN, readReceipts: true };
    await sync.start();
    updates.mockRejectedValueOnce(new Error('nope'));
    await expect(sync.updatePhonePrivacy({ readReceipts: false })).resolves.toBe(false);
    expect(phoneState(stores).values.readReceipts).toBe(true);
    expect(onError).toHaveBeenCalled();
  });

  it('does nothing when the phone’s settings are not known (the caller edits the local one)', async () => {
    const { sync, updates } = await setup({ supported: false });
    await expect(sync.updatePhonePrivacy({ readReceipts: false })).resolves.toBe(false);
    expect(updates).not.toHaveBeenCalled();
  });
});
