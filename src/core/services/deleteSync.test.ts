import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import type { BackendEvents, MessageRef } from '@/core/backend';
import { addLogSink } from '@/core/lib/log';
import {
  directConversationId,
  messageId,
  pendingMessageId,
  systemMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { ExpiryService } from './ExpiryService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

const message = (
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

async function setup(options: { deleteSync?: boolean } = {}) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  backend.capabilities.setFeature('deleteSync', options.deleteSync ?? true);
  const repository = new MemoryMessageRepository();
  const stores = createStores();
  const onError = vi.fn();
  const receipts = new ReceiptBuffer();
  const expiry = new ExpiryService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    onError,
  });
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock: scheduler,
    scheduler,
    receipts,
    expiry,
    onError,
  });
  await sync.start();
  const send = new SendService({
    backend,
    repository,
    stores,
    clock: scheduler,
    receipts,
    rememberPurged: (id) => {
      expiry.rememberPurged(id);
    },
    onError,
  });
  const conv = backend.world.conversationIds.get('crux')!;
  const other = backend.world.conversationIds.get('request-dm')!;
  const group = backend.world.conversationIds.get('request-group')!;
  const selfId = backend.world.self.id;
  const peerOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const peer = peerOf(conv);
  // The demo world's chats come with history; these tests want an empty one.
  for (const c of [conv, other, group]) {
    for (const m of await repository.page(c, { limit: 5_000 })) await repository.delete(m.id);
    const last = stores.conversations.getState().lastMessage[c];
    if (last) stores.conversations.getState().replaceLatest(c, last.id, undefined);
    stores.conversations.getState().setUnread(c, { count: 0, mentions: 0 });
  }
  /** Delivers messages from the peer (oldest first) and waits for them to land. */
  const arrive = async (conversationId: ConversationId, sentAts: number[], author = peer) => {
    // An open, empty window at the present, so arrivals show in it like in an open chat.
    if (!stores.messages.getState().windows[conversationId]?.loaded)
      stores.messages
        .getState()
        .replaceWindow(conversationId, [], { hasMoreBefore: false, hasMoreAfter: false });
    for (const sentAt of sentAts) backend.deliver(message(conversationId, author, sentAt));
    await sync.idle();
  };
  const deleted = async (event: Partial<BackendEvents['deleteForMe']>) => {
    backend.deliverDeleteForMe({ messages: [], conversations: [], ...event });
    await sync.idle();
  };
  const ids = async (conversationId: ConversationId) =>
    (await repository.page(conversationId, { limit: 500 })).map((m) => m.sentAt);
  const shown = (conversationId: ConversationId) => {
    const window = stores.messages.getState().windows[conversationId];
    return (window?.ids ?? []).map((id) => window!.byId[id]!.sentAt);
  };
  return {
    backend,
    repository,
    stores,
    sync,
    send,
    onError,
    conv,
    other,
    group,
    selfId,
    peer,
    peerOf,
    arrive,
    deleted,
    ids,
    shown,
  };
}

const ref = (authorId: string, sentAt: number): MessageRef => ({ authorId, sentAt });

describe('delete for me sync: outgoing', () => {
  it('tells the other devices, once per message, after the local delete', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    const first = message(t.conv, t.peer, NOW + 1);
    const second = message(t.conv, t.peer, NOW + 2);
    await t.send.deleteForMe(t.conv, first);
    await t.send.deleteForMe(t.conv, second);
    await vi.waitFor(() => {
      expect(t.backend.deleteSyncs).toHaveLength(2);
    });
    expect(t.backend.deleteSyncs).toEqual([
      { conversationId: t.conv, messages: [ref(t.peer, NOW + 1)] },
      { conversationId: t.conv, messages: [ref(t.peer, NOW + 2)] },
    ]);
    expect(await t.ids(t.conv)).toEqual([]);
  });

  it('takes a deleted unread message off the unread count, so reading the chat leaves none behind', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    const unread = () => t.stores.conversations.getState().unread[t.conv]?.count ?? 0;
    expect(unread()).toBe(2);
    const [first] = await t.repository.page(t.conv, { limit: 500 });
    await t.send.deleteForMe(t.conv, first!);
    expect(unread()).toBe(1);
    await t.sync.markConversationRead(t.conv);
    expect(unread()).toBe(0);
  });

  it('sends nothing without the deleteSync feature, and the message is still deleted', async () => {
    const t = await setup({ deleteSync: false });
    await t.arrive(t.conv, [NOW + 1]);
    const spy = vi.spyOn(t.backend, 'syncDeleteForMe');
    await t.send.deleteForMe(t.conv, message(t.conv, t.peer, NOW + 1));
    await Promise.resolve();
    expect(spy).not.toHaveBeenCalled();
    expect(await t.ids(t.conv)).toEqual([]);
  });

  it('a failed sync keeps the message deleted, reports no error, and logs no ids', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    t.backend.deleteSyncFailures.push(new Error(`no route to ${t.peer} at ${NOW + 1}`));
    const lines: string[] = [];
    const off = addLogSink({
      write: (_level, _scope, text) => {
        lines.push(text);
      },
    });
    const spy = vi.spyOn(t.backend, 'syncDeleteForMe');
    await t.send.deleteForMe(t.conv, message(t.conv, t.peer, NOW + 1));
    await vi.waitFor(() => {
      expect(spy).toHaveBeenCalledTimes(1);
    });
    await expect(spy.mock.results[0]!.value).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 0));
    off();
    expect(t.backend.deleteSyncs).toEqual([]);
    expect(await t.ids(t.conv)).toEqual([]);
    expect(t.shown(t.conv)).not.toContain(NOW + 1);
    expect(t.onError).not.toHaveBeenCalled();
    const failure = lines.filter((l) => l.includes('delete sync failed'));
    expect(failure).toHaveLength(1);
    expect(failure[0]).not.toContain(t.peer);
    expect(failure[0]).not.toContain(String(NOW + 1));
  });

  it('does not sync an unsent (pending) message or a system line', async () => {
    const t = await setup();
    const spy = vi.spyOn(t.backend, 'syncDeleteForMe');
    const pending = message(t.conv, t.selfId, NOW + 3, {
      id: pendingMessageId('n-1'),
      status: 'pending',
    });
    await t.send.deleteForMe(t.conv, pending);
    const system = message(t.conv, t.selfId, NOW + 4, {
      id: systemMessageId(t.selfId, NOW + 4, 'timer'),
      kind: 'system',
    });
    await t.send.deleteForMe(t.conv, system);
    await new Promise((r) => setTimeout(r, 0));
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('delete for me sync: incoming messages', () => {
  it('removes a named message from the window, the repository and the sidebar preview', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    expect(t.stores.conversations.getState().lastMessage[t.conv]?.sentAt).toBe(NOW + 3);
    await t.deleted({ messages: [{ conversationId: t.conv, ...ref(t.peer, NOW + 3) }] });
    expect(await t.ids(t.conv)).toEqual([NOW + 1, NOW + 2]);
    expect(t.shown(t.conv)).not.toContain(NOW + 3);
    expect(t.stores.conversations.getState().lastMessage[t.conv]?.sentAt).toBe(NOW + 2);
    expect(t.onError).not.toHaveBeenCalled();
  });

  it('ignores a message that is not found, one in another chat, and one of another author', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    await t.deleted({
      messages: [
        { conversationId: t.conv, ...ref(t.peer, NOW + 99) },
        { conversationId: t.other, ...ref(t.peer, NOW + 1) },
        { conversationId: t.conv, ...ref(t.selfId, NOW + 1) },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 1]);
    expect(t.onError).not.toHaveBeenCalled();
  });

  it('keeps the unread count consistent when an unread message is deleted', async () => {
    const t = await setup();
    t.stores.ui.getState().setWindowFocused(false);
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    const before = t.stores.conversations.getState().unread[t.conv]?.count ?? 0;
    expect(before).toBeGreaterThanOrEqual(3);
    await t.deleted({ messages: [{ conversationId: t.conv, ...ref(t.peer, NOW + 2) }] });
    expect(t.stores.conversations.getState().unread[t.conv]?.count).toBe(before - 1);
  });

  it('announces the removal so a notification quoting it stops applying', async () => {
    const t = await setup();
    t.stores.ui.getState().setWindowFocused(false);
    await t.arrive(t.conv, [NOW + 1]);
    const removed: string[] = [];
    t.sync.on('messageRemoved', ({ message: m }) => removed.push(m.id));
    await t.deleted({ messages: [{ conversationId: t.conv, ...ref(t.peer, NOW + 1) }] });
    expect(removed).toEqual([messageId(t.peer, NOW + 1)]);
  });
});

describe('delete for me sync: incoming chat deletes', () => {
  const clear = (
    conversationId: ConversationId,
    mostRecent: MessageRef[],
    isFullDelete = false,
    mostRecentNonExpiring: MessageRef[] = [],
  ) => ({ conversationId, mostRecent, mostRecentNonExpiring, isFullDelete });

  it('deletes up to and including the newest named message that exists here', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3, NOW + 4]);
    await t.deleted({
      conversations: [clear(t.conv, [ref(t.peer, NOW + 3), ref(t.peer, NOW + 99)])],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 4]);
    expect(t.shown(t.conv)).toEqual([NOW + 4]);
    expect(t.stores.conversations.getState().lastMessage[t.conv]?.sentAt).toBe(NOW + 4);
  });

  it('deletes nothing when none of the named messages exists here', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 99)])] });
    expect(await t.ids(t.conv)).toEqual([NOW + 1, NOW + 2]);
    // A full delete that names nothing found anchors nothing; the chat is only
    // emptied when no real message remains, and these two are still here.
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 99)], true)] });
    expect(await t.ids(t.conv)).toEqual([NOW + 1, NOW + 2]);
  });

  it('falls back to the non-expiring list when no recent one exists here', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    await t.deleted({
      conversations: [clear(t.conv, [ref(t.peer, NOW + 99)], false, [ref(t.peer, NOW + 2)])],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 3]);
  });

  it('a full delete also clears the system lines left behind', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    await t.repository.upsert(
      message(t.conv, t.selfId, NOW + 5, {
        id: systemMessageId(t.selfId, NOW + 5, 'timer'),
        kind: 'system',
      }),
      (_old, next) => next,
    );
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 2)], false)] });
    expect(await t.ids(t.conv)).toEqual([NOW + 5]);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 2)], true)] });
    expect(await t.ids(t.conv)).toEqual([]);
    expect(t.stores.conversations.getState().lastMessage[t.conv]).toBeUndefined();
  });

  it('a full delete leaves the chat alone while a real message remains', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 1)], true)] });
    expect(await t.ids(t.conv)).toEqual([NOW + 2]);
  });

  it('a local-only delete clears a chat of system lines only, and refuses while a real message remains', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    await t.repository.upsert(
      message(t.conv, t.selfId, NOW + 5, {
        id: systemMessageId(t.selfId, NOW + 5, 'timer'),
        kind: 'system',
      }),
      (_old, next) => next,
    );
    await t.deleted({ conversations: [clear(t.conv, [], true)] });
    expect(await t.ids(t.conv)).toEqual([NOW + 1, NOW + 5]);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 1)])] });
    await t.deleted({ conversations: [clear(t.conv, [], true)] });
    expect(await t.ids(t.conv)).toEqual([]);
    expect(t.shown(t.conv)).toEqual([]);
  });

  it('keeps an unsent message of the chat, even one older than the stretch cleared', async () => {
    const t = await setup();
    await t.repository.upsert(
      message(t.conv, t.selfId, NOW + 7, {
        id: pendingMessageId('n-2'),
        status: 'pending',
      }),
      (_old, next) => next,
    );
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 2)], true)] });
    expect(await t.ids(t.conv)).toEqual([NOW + 7]);
  });

  it('keeps unread consistent after a chat delete', async () => {
    const t = await setup();
    t.stores.ui.getState().setWindowFocused(false);
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    const before = t.stores.conversations.getState().unread[t.conv]?.count ?? 0;
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 2)])] });
    expect(t.stores.conversations.getState().unread[t.conv]?.count).toBe(before - 2);
    await t.deleted({ conversations: [clear(t.conv, [ref(t.peer, NOW + 3)], true)] });
    expect(t.stores.conversations.getState().unread[t.conv]?.count ?? 0).toBe(0);
  });
});

describe('delete for me sync: edited messages', () => {
  const edited = async (t: Awaited<ReturnType<typeof setup>>, sentAt: number, editedAt: number) => {
    await t.arrive(t.conv, [sentAt]);
    await t.repository.update(messageId(t.peer, sentAt), (m) => ({ ...m, edits: 1, editedAt }));
  };

  it('the other device may name the original time or the latest revision’s', async () => {
    const t = await setup();
    await edited(t, NOW + 1, NOW + 50);
    await edited(t, NOW + 2, NOW + 60);
    await t.arrive(t.conv, [NOW + 3]);
    await t.deleted({
      messages: [
        { conversationId: t.conv, ...ref(t.peer, NOW + 1) },
        { conversationId: t.conv, ...ref(t.peer, NOW + 60) },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 3]);
    expect(t.shown(t.conv)).toEqual([NOW + 3]);
  });

  it('a revision time of another author’s or another chat’s message does not match', async () => {
    const t = await setup();
    await edited(t, NOW + 1, NOW + 50);
    await t.deleted({
      messages: [
        { conversationId: t.conv, ...ref(t.selfId, NOW + 50) },
        { conversationId: t.other, ...ref(t.peer, NOW + 50) },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 1]);
  });

  it('a chat delete anchors on an edited message named by its latest revision time', async () => {
    const t = await setup();
    await edited(t, NOW + 1, NOW + 50);
    await t.arrive(t.conv, [NOW + 2, NOW + 3]);
    await t.deleted({
      conversations: [
        {
          conversationId: t.conv,
          mostRecent: [ref(t.peer, NOW + 50)],
          mostRecentNonExpiring: [],
          isFullDelete: false,
        },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 2, NOW + 3]);
    await t.arrive(t.conv, [NOW + 4]);
    await t.repository.update(messageId(t.peer, NOW + 3), (m) => ({ ...m, editedAt: NOW + 70 }));
    await t.deleted({
      conversations: [
        {
          conversationId: t.conv,
          mostRecent: [ref(t.peer, NOW + 70)],
          mostRecentNonExpiring: [],
          isFullDelete: false,
        },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 4]);
  });

  it('deleting an edited message here tells the others its original time (what Signal Desktop sends)', async () => {
    const t = await setup();
    await edited(t, NOW + 1, NOW + 50);
    const stored = (await t.repository.get(messageId(t.peer, NOW + 1)))!;
    await t.send.deleteForMe(t.conv, stored);
    await vi.waitFor(() => {
      expect(t.backend.deleteSyncs).toHaveLength(1);
    });
    expect(t.backend.deleteSyncs[0]).toEqual({
      conversationId: t.conv,
      messages: [ref(t.peer, NOW + 1)],
    });
  });
});

describe('delete for me sync: tombstones', () => {
  it('a synced delete is not undone when the message is delivered again', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2]);
    await t.deleted({ messages: [{ conversationId: t.conv, ...ref(t.peer, NOW + 1) }] });
    await t.arrive(t.conv, [NOW + 1]);
    expect(await t.ids(t.conv)).toEqual([NOW + 2]);
    expect(t.shown(t.conv)).toEqual([NOW + 2]);
  });

  it('a synced chat delete is not undone by a replay of the messages it removed', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    await t.deleted({
      conversations: [
        {
          conversationId: t.conv,
          mostRecent: [ref(t.peer, NOW + 2)],
          mostRecentNonExpiring: [],
          isFullDelete: false,
        },
      ],
    });
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3]);
    expect(await t.ids(t.conv)).toEqual([NOW + 3]);
  });

  it('a delete made here is not undone when the message is delivered again', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    await t.send.deleteForMe(t.conv, message(t.conv, t.peer, NOW + 1));
    await t.arrive(t.conv, [NOW + 1]);
    expect(await t.ids(t.conv)).toEqual([]);
    expect(t.shown(t.conv)).toEqual([]);
  });
});

describe('delete for me sync: one store update', () => {
  it('removes every message a synced delete names from an open list in a single update', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3, NOW + 4]);
    let updates = 0;
    const off = t.stores.messages.subscribe(() => {
      updates++;
    });
    await t.deleted({
      messages: [NOW + 1, NOW + 2, NOW + 3].map((at) => ({
        conversationId: t.conv,
        ...ref(t.peer, at),
      })),
    });
    off();
    expect(updates).toBe(1);
    expect(t.shown(t.conv)).toEqual([NOW + 4]);
  });

  it('clears a stretch of a chat in a single update', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1, NOW + 2, NOW + 3, NOW + 4]);
    let updates = 0;
    const off = t.stores.messages.subscribe(() => {
      updates++;
    });
    await t.deleted({
      conversations: [
        {
          conversationId: t.conv,
          mostRecent: [ref(t.peer, NOW + 3)],
          mostRecentNonExpiring: [],
          isFullDelete: false,
        },
      ],
    });
    off();
    expect(updates).toBe(1);
    expect(t.shown(t.conv)).toEqual([NOW + 4]);
  });

  it('removing from a store that does not hold the chat does not update it', async () => {
    const t = await setup();
    let updates = 0;
    const off = t.stores.messages.subscribe(() => {
      updates++;
    });
    t.stores.messages.getState().removeMany(t.conv, [messageId(t.peer, NOW + 1)]);
    off();
    expect(updates).toBe(0);
  });
});

describe('delete for me sync: other chats and authors', () => {
  it('removes a message of a group chat, and only that group’s', async () => {
    const t = await setup();
    const member = t.backend.world.conversations
      .get(t.group)!
      .memberIds.find((m) => m !== t.selfId)!;
    await t.arrive(t.group, [NOW + 1, NOW + 2], member);
    await t.arrive(t.conv, [NOW + 1]);
    await t.deleted({ messages: [{ conversationId: t.group, ...ref(member, NOW + 1) }] });
    expect(await t.ids(t.group)).toEqual([NOW + 2]);
    expect(t.shown(t.group)).toEqual([NOW + 2]);
    expect(await t.ids(t.conv)).toEqual([NOW + 1]);
  });

  it('clears a group chat up to the newest message named', async () => {
    const t = await setup();
    const member = t.backend.world.conversations
      .get(t.group)!
      .memberIds.find((m) => m !== t.selfId)!;
    await t.arrive(t.group, [NOW + 1, NOW + 2, NOW + 3], member);
    await t.deleted({
      conversations: [
        {
          conversationId: t.group,
          mostRecent: [ref(member, NOW + 2)],
          mostRecentNonExpiring: [],
          isFullDelete: false,
        },
      ],
    });
    expect(await t.ids(t.group)).toEqual([NOW + 3]);
  });

  it('removes a message the user sent, deleted on the phone (its author is the user)', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    await t.repository.upsert(message(t.conv, t.selfId, NOW + 2), (_old, next) => next);
    t.stores.messages.getState().appendLive(message(t.conv, t.selfId, NOW + 2));
    await t.deleted({ messages: [{ conversationId: t.conv, ...ref(t.selfId, NOW + 2) }] });
    expect(await t.ids(t.conv)).toEqual([NOW + 1]);
    expect(t.shown(t.conv)).toEqual([NOW + 1]);
  });

  it('removes a note-to-self message, and tells the others about one deleted here', async () => {
    const t = await setup();
    const note = directConversationId(t.selfId);
    await t.repository.upsert(message(note, t.selfId, NOW + 1), (_old, next) => next);
    await t.repository.upsert(message(note, t.selfId, NOW + 2), (_old, next) => next);
    await t.deleted({ messages: [{ conversationId: note, ...ref(t.selfId, NOW + 1) }] });
    expect(await t.ids(note)).toEqual([NOW + 2]);
    await t.send.deleteForMe(note, message(note, t.selfId, NOW + 2));
    await vi.waitFor(() => {
      expect(t.backend.deleteSyncs).toHaveLength(1);
    });
    expect(t.backend.deleteSyncs[0]).toEqual({
      conversationId: note,
      messages: [ref(t.selfId, NOW + 2)],
    });
  });

  it('leaves a message still being sent alone, whatever the other device names', async () => {
    const t = await setup();
    await t.arrive(t.conv, [NOW + 1]);
    const pending = message(t.conv, t.selfId, NOW + 2, {
      id: pendingMessageId('n-3'),
      status: 'pending',
    });
    await t.repository.upsert(pending, (_old, next) => next);
    await t.deleted({
      messages: [
        { conversationId: t.conv, ...ref(t.selfId, NOW + 2) },
        { conversationId: t.conv, ...ref(t.peer, NOW + 1) },
      ],
    });
    expect(await t.ids(t.conv)).toEqual([NOW + 2]);
    expect(t.onError).not.toHaveBeenCalled();
  });
});
