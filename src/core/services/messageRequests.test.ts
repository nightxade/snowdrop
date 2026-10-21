import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { HistoryService } from './HistoryService';
import {
  directConversationId,
  messageId,
  type Conversation,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import {
  createLocalStore,
  createStores,
  defaultLocalData,
  selectMessageRequestState,
  type Stores,
} from '@/core/stores';
import { MessageRequestService } from './MessageRequestService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

async function setup(
  options: {
    stores?: Stores;
    repository?: MemoryMessageRepository;
    prepare?: (backend: MockBackend) => void;
  } = {},
) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
  options.prepare?.(backend);
  const repository = options.repository ?? new MemoryMessageRepository();
  const stores = options.stores ?? createStores();
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
  });
  const requests = new MessageRequestService({
    backend,
    repository,
    stores,
    sync,
    clock: scheduler,
    onError,
  });
  const dm = backend.world.conversationIds.get('request-dm')!;
  const group = backend.world.conversationIds.get('request-group')!;
  const selfId = backend.world.self.id;
  const peerOf = (id: ConversationId) =>
    backend.world.conversations.get(id)!.memberIds.find((m) => m !== selfId)!;
  const state = (id: ConversationId) => selectMessageRequestState(stores, id);
  return {
    scheduler,
    backend,
    repository,
    stores,
    sync,
    send,
    requests,
    onError,
    dm,
    group,
    selfId,
    peerOf,
    state,
  };
}

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

describe('which conversations are message requests', () => {
  it('lists a stranger’s DM and a stranger’s group as requests, and every other demo chat as accepted', async () => {
    const { backend, state, dm, group } = await setup();
    expect(state(dm)).toBe('request');
    expect(state(group)).toBe('request');
    const others = [...backend.world.conversations.keys()].filter(
      (id) => id !== dm && id !== group,
    );
    expect(others.length).toBeGreaterThan(10);
    expect(others.filter((id) => state(id) !== 'accepted')).toEqual([]);
  });

  it('accepts a DM whose peer shares a profile with the user (an accepted request elsewhere)', async () => {
    const { backend, stores, state, dm, peerOf } = await setup();
    stores.contacts
      .getState()
      .upsert({ ...backend.world.contacts.get(peerOf(dm))!, profileSharing: true });
    expect(state(dm)).toBe('accepted');
  });

  it('accepts a group that has a saved contact in it', async () => {
    const { backend, stores, state, group, peerOf, selfId } = await setup();
    const friend = [...backend.world.contacts.values()].find(
      (c) => c.inContacts && c.id !== selfId,
    )!;
    const conversation = stores.conversations.getState().byId[group]!;
    stores.conversations
      .getState()
      .upsert({ ...conversation, memberIds: [...conversation.memberIds, friend.id] });
    expect(state(group)).toBe('accepted');
    expect(peerOf(group)).toBeTruthy();
  });

  it('treats a blocked contact, or a blocked group, as blocked even when it was accepted', async () => {
    const { backend, stores, state, dm, group, peerOf } = await setup();
    stores.local.getState().markAccepted(dm, NOW);
    stores.local.getState().markAccepted(group, NOW);
    stores.contacts
      .getState()
      .upsert({ ...backend.world.contacts.get(peerOf(dm))!, blocked: true });
    stores.conversations
      .getState()
      .upsert({ ...stores.conversations.getState().byId[group]!, blocked: true });
    expect(state(dm)).toBe('blocked');
    expect(state(group)).toBe('blocked');
  });

  it('never makes the note to self a request', async () => {
    const { stores, state, selfId } = await setup();
    const own = directConversationId(selfId);
    stores.conversations.getState().upsert({
      id: own,
      kind: 'direct',
      title: 'Note to self',
      memberIds: [selfId],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    });
    expect(state(own)).toBe('accepted');
  });
});

describe('what a message request withholds', () => {
  it('sends no read receipts while a request is read, and none retroactively unless accepted', async () => {
    const { backend, sync, requests, dm, state } = await setup();
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(dm);
    expect(markRead).not.toHaveBeenCalled();
    expect(state(dm)).toBe('request');
    // Desktop's accept sends them for what was read: the same here, once, on accept.
    expect(await requests.accept(dm)).toBe(true);
    expect(markRead).toHaveBeenCalledTimes(1);
    expect(markRead.mock.calls[0]?.[0]).toBe(dm);
    expect(markRead.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it('sends receipts only for what the user had read, when accepting', async () => {
    const { backend, stores, sync, requests, dm, peerOf } = await setup();
    const markRead = vi.spyOn(backend, 'markRead');
    // A third message arrives after the user read the first two.
    await sync.markConversationRead(dm);
    backend.deliver(incoming(dm, peerOf(dm), NOW + 5));
    await sync.idle();
    expect(stores.conversations.getState().unread[dm]?.count).toBe(1);
    await requests.accept(dm);
    expect(markRead.mock.calls[0]?.[1]).toHaveLength(2);
    // Reading the rest afterwards is an ordinary read: now it is accepted, so it is sent.
    await sync.markConversationRead(dm);
    expect(markRead).toHaveBeenCalledTimes(2);
    expect(markRead.mock.calls[1]?.[1]).toEqual([{ authorId: peerOf(dm), sentAt: NOW + 5 }]);
  });

  it('auto-reading a request that is open sends nothing either', async () => {
    const { backend, stores, sync, dm, peerOf } = await setup();
    const markRead = vi.spyOn(backend, 'markRead');
    stores.ui.getState().selectConversation(dm);
    backend.deliver(incoming(dm, peerOf(dm), NOW + 5));
    await sync.idle();
    expect(stores.conversations.getState().unread[dm]?.count).toBe(0);
    expect(markRead).not.toHaveBeenCalled();
  });

  it('sends no typing indicator to a request, and starts once it is accepted', async () => {
    const { backend, send, requests, dm } = await setup();
    await send.setTyping(dm, true);
    await send.setTyping(dm, false);
    expect(backend.typingSent).toEqual([]);
    await requests.accept(dm);
    await send.setTyping(dm, true);
    expect(backend.typingSent).toEqual([{ conversationId: dm, typing: true }]);
  });

  it('still reads receipts and typing normally in an accepted chat', async () => {
    const { backend, sync, send } = await setup();
    const conv = backend.world.conversationIds.get('crux')!;
    const markRead = vi.spyOn(backend, 'markRead');
    await sync.markConversationRead(conv);
    expect(markRead).toHaveBeenCalledTimes(1);
    await send.setTyping(conv, true);
    expect(backend.typingSent).toHaveLength(1);
  });
});

describe('answering a request', () => {
  it('accept tells the backend, accepts locally and lifts the request', async () => {
    const { backend, stores, requests, dm, state } = await setup();
    expect(await requests.accept(dm)).toBe(true);
    expect(backend.requestResponses).toEqual([{ conversationId: dm, response: 'accept' }]);
    expect(stores.local.getState().acceptedChats[dm]).toBe(NOW);
    expect(state(dm)).toBe('accepted');
  });

  it('accepts a group request with the group id', async () => {
    const { backend, requests, group, state } = await setup();
    expect(await requests.accept(group)).toBe(true);
    expect(backend.requestResponses).toEqual([{ conversationId: group, response: 'accept' }]);
    expect(state(group)).toBe('accepted');
  });

  it('a failed accept changes nothing and reports the error', async () => {
    const { backend, requests, stores, dm, state, onError } = await setup();
    vi.spyOn(backend, 'respondToMessageRequest').mockRejectedValueOnce(new Error('offline'));
    expect(await requests.accept(dm)).toBe(false);
    expect(state(dm)).toBe('request');
    expect(stores.local.getState().acceptedChats[dm]).toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });

  it('delete tells the backend, removes the chat and its messages, and keeps it from coming back', async () => {
    const { backend, repository, stores, sync, requests, dm } = await setup();
    expect(await repository.count(dm)).toBeGreaterThan(0);
    expect(await requests.remove(dm)).toBe(true);
    expect(backend.requestResponses).toEqual([{ conversationId: dm, response: 'delete' }]);
    expect(stores.conversations.getState().byId[dm]).toBeUndefined();
    expect(await repository.count(dm)).toBe(0);
    expect(stores.local.getState().deletedChats[dm]).toBe(NOW);
    expect(stores.local.getState().acceptedChats[dm]).toBeUndefined();
    // A re-list that still names it (a peer list, the history archive) leaves it hidden.
    const named: Conversation = {
      id: dm,
      kind: 'direct',
      title: 'Marlowe Quist',
      memberIds: [],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: NOW,
    };
    backend.emit('conversationUpdated', named);
    await sync.idle();
    expect(stores.conversations.getState().byId[dm]).toBeUndefined();
  });

  it('delete removes a group request the same way', async () => {
    const { backend, stores, requests, group } = await setup();
    expect(await requests.remove(group)).toBe(true);
    expect(backend.requestResponses).toEqual([{ conversationId: group, response: 'delete' }]);
    expect(stores.conversations.getState().byId[group]).toBeUndefined();
  });

  it('a new message from someone deleted starts a fresh request', async () => {
    const { backend, stores, sync, requests, dm, peerOf, state } = await setup();
    const peer = peerOf(dm);
    await requests.remove(dm);
    backend.deliver(incoming(dm, peer, NOW + 10, { body: 'sorry, me again' }));
    await sync.idle();
    expect(stores.local.getState().deletedChats[dm]).toBeUndefined();
    expect(stores.conversations.getState().byId[dm]).toBeDefined();
    expect(state(dm)).toBe('request');
  });

  it('block tells the backend and shows the chat as blocked; unblock accepts it', async () => {
    const { backend, stores, requests, dm, state } = await setup();
    expect(await requests.block(dm)).toBe(true);
    expect(backend.requestResponses.at(-1)).toEqual({ conversationId: dm, response: 'block' });
    expect(state(dm)).toBe('blocked');
    expect(stores.conversations.getState().byId[dm]).toBeDefined();
    expect(await requests.unblock(dm)).toBe(true);
    expect(backend.requestResponses.at(-1)).toEqual({ conversationId: dm, response: 'unblock' });
    expect(state(dm)).toBe('accepted');
  });

  it('blocks and unblocks a group through the conversation', async () => {
    const { backend, stores, requests, group, state } = await setup();
    await requests.block(group);
    expect(stores.conversations.getState().byId[group]?.blocked).toBe(true);
    expect(state(group)).toBe('blocked');
    await requests.unblock(group);
    expect(stores.conversations.getState().byId[group]?.blocked).toBeUndefined();
    expect(backend.requestResponses.map((r) => r.response)).toEqual(['block', 'unblock']);
  });
});

describe('sending accepts', () => {
  it('writing to a request accepts it, here and for the typing that follows', async () => {
    const { send, stores, dm, state, backend } = await setup();
    await send.send({ conversationId: dm, text: 'hi, sure', mentionIds: [], attachments: [] });
    expect(state(dm)).toBe('accepted');
    expect(stores.local.getState().acceptedChats[dm]).toBe(NOW);
    await send.setTyping(dm, true);
    expect(backend.typingSent).toHaveLength(1);
  });

  it('sending a sticker accepts too', async () => {
    const { send, dm, state } = await setup();
    await send.sendSticker({ conversationId: dm, sticker: { packId: 'ab', stickerId: 1 } });
    expect(state(dm)).toBe('accepted');
  });
});

describe('an outgoing message anywhere accepts the chat (Desktop: sentMessageCount > 0)', () => {
  const own = (conversationId: ConversationId, selfId: string, sentAt: number): Message =>
    incoming(conversationId, selfId, sentAt, { body: 'sent from my phone', status: 'sent' });

  it('a live message the user sent from the phone to a non-contact accepts it, and shows it', async () => {
    const { backend, sync, state, stores, selfId, dm } = await setup();
    const stranger = directConversationId('someone-new');
    backend.emit('message', own(stranger, selfId, NOW + 5));
    await sync.idle();
    expect(stores.conversations.getState().byId[stranger]).toBeDefined();
    expect(state(stranger)).toBe('accepted');
    // An existing request gets accepted the same way, and nothing else changes.
    expect(state(dm)).toBe('request');
    backend.emit('message', own(dm, selfId, NOW + 6));
    await sync.idle();
    expect(state(dm)).toBe('accepted');
  });

  it('a system line from the user does not accept anything', async () => {
    const { backend, sync, state, selfId, dm } = await setup();
    backend.emit('message', { ...own(dm, selfId, NOW + 5), kind: 'system', systemText: 'x' });
    await sync.idle();
    expect(state(dm)).toBe('request');
  });

  it('history seeded at the first sync with an outgoing message accepts that chat only', async () => {
    const { state, dm, group } = await setup({
      prepare: (backend) => {
        const world = backend.world;
        const history = world.histories.get(world.conversationIds.get('request-dm')!)!;
        history.push(own(history[0]!.conversationId, world.self.id, NOW - 1000));
      },
    });
    expect(state(dm)).toBe('accepted');
    expect(state(group)).toBe('request');
  });

  it('a history page loaded later with an outgoing message accepts it', async () => {
    const { backend, repository, stores, state, dm, selfId } = await setup();
    const history = new HistoryService({ backend, repository, stores, pageSize: 50 });
    await repository.deleteConversation(dm);
    stores.messages.getState().closeWindow(dm);
    vi.spyOn(backend, 'fetchHistory').mockResolvedValue({
      messages: [own(dm, selfId, NOW - 2000)],
      hasMoreBefore: false,
    });
    expect(state(dm)).toBe('request');
    await history.open(dm);
    expect(state(dm)).toBe('accepted');
  });

  describe('the archive check (background, request chats with history only)', () => {
    /** Gives the mock backend an archive that says who the user wrote to. */
    const withArchive =
      (wrote: Set<string>, log: string[], gate?: Promise<void>) => (backend: MockBackend) => {
        Object.assign(backend, {
          historyHasOutgoing: async (id: string) => {
            log.push(`start:${id}`);
            await gate;
            await Promise.resolve();
            log.push(`end:${id}`);
            return wrote.has(id);
          },
        });
        // Only the stranger chats have archived history in this scenario.
        const list = backend.listConversations.bind(backend);
        backend.listConversations = async () =>
          (await list()).map((c) => ({ ...c, historyHasMessages: true }));
      };
    const settle = () => new Promise((r) => setTimeout(r, 5));

    it('accepts a request chat the archive says the user wrote in, and only asks about requests', async () => {
      const log: string[] = [];
      const ids = new Set<string>();
      const s = await setup({
        prepare: (backend) => {
          ids.add(backend.world.conversationIds.get('request-group')!);
          withArchive(ids, log)(backend);
        },
      });
      await settle();
      expect(s.state(s.group)).toBe('accepted');
      expect(s.state(s.dm)).toBe('request');
      // Only the two requests were asked about, not the ~22 ordinary chats.
      expect(log.filter((l) => l.startsWith('start:')).sort()).toEqual(
        [`start:${s.dm}`, `start:${s.group}`].sort(),
      );
    });

    it('is sequential and does not hold up the sync', async () => {
      const log: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const s = await setup({ prepare: withArchive(new Set(), log, gate) });
      // setup() returned: the sync finished although the first ask is still pending.
      expect(s.stores.session.getState().ready).toBe(true);
      await settle();
      expect(log).toHaveLength(1);
      release();
      await settle();
      expect(log.map((l) => l.split(':')[0])).toEqual(['start', 'end', 'start', 'end']);
    });

    it('keeps a request a request when the answer is no, and asks once', async () => {
      const log: string[] = [];
      const s = await setup({ prepare: withArchive(new Set(), log) });
      await settle();
      expect(s.state(s.dm)).toBe('request');
      await s.sync.start();
      await settle();
      expect(log.filter((l) => l.startsWith('start:'))).toHaveLength(2);
    });
  });

  it('never un-accepts: later incoming messages and re-listing leave an accepted chat accepted', async () => {
    const { backend, sync, state, selfId, dm, peerOf } = await setup();
    backend.emit('message', own(dm, selfId, NOW + 1));
    backend.emit('message', incoming(dm, peerOf(dm), NOW + 2));
    await sync.idle();
    expect(state(dm)).toBe('accepted');
  });
});

describe('existing chats on upgrade', () => {
  it('keeps every conversation the device already knew accepted, once, and judges only new ones', async () => {
    // A first run: the demo's chats (strangers included) are all known to this install.
    const first = await setup();
    const repository = first.repository;
    const stores = createStores({
      local: { ...defaultLocalData(), requestsSeeded: false },
    });
    // Same repository (so read positions exist), fresh local data: what an upgrade looks like.
    const upgraded = await setup({ repository, stores });
    expect(stores.local.getState().requestsSeeded).toBe(true);
    expect(upgraded.state(upgraded.dm)).toBe('accepted');
    expect(upgraded.state(upgraded.group)).toBe('accepted');
    // Nothing is re-judged on a later start.
    stores.local.getState().grandfather([], NOW);
    expect(Object.keys(stores.local.getState().acceptedChats).length).toBeGreaterThan(10);
  });

  it('a fresh install grandfathers nothing: strangers are requests from the start', async () => {
    const { stores, state, dm, group } = await setup();
    expect(stores.local.getState().requestsSeeded).toBe(true);
    // Nothing is grandfathered; chats the user wrote in are accepted by that alone.
    expect(stores.local.getState().acceptedChats[dm]).toBeUndefined();
    expect(stores.local.getState().acceptedChats[group]).toBeUndefined();
    expect(state(dm)).toBe('request');
    expect(state(group)).toBe('request');
  });

  it('does not accept a chat that first shows up after the upgrade', async () => {
    const first = await setup();
    const stores = createStores({ local: defaultLocalData() });
    const upgraded = await setup({ repository: first.repository, stores });
    const newcomer = backendOnlyConversation(upgraded.selfId);
    upgraded.stores.conversations.getState().upsert(newcomer);
    expect(upgraded.state(newcomer.id)).toBe('request');
  });
});

function backendOnlyConversation(selfId: string): Conversation {
  const id = directConversationId('someone-new');
  return {
    id,
    kind: 'direct',
    title: 'Someone new',
    memberIds: [selfId, 'someone-new'],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: NOW,
  };
}

describe('local state', () => {
  it('records acceptance once, and a delete lifts it', () => {
    const store = createLocalStore();
    const id = directConversationId('x');
    store.getState().markAccepted(id, 5);
    store.getState().markAccepted(id, 9);
    expect(store.getState().acceptedChats[id]).toBe(5);
    store.getState().markDeleted(id, 10);
    expect(store.getState().acceptedChats[id]).toBeUndefined();
    expect(store.getState().deletedChats[id]).toBe(10);
    store.getState().markAccepted(id, 11);
    expect(store.getState().deletedChats[id]).toBeUndefined();
    expect(store.getState().acceptedChats[id]).toBe(11);
  });

  it('grandfathers only once', () => {
    const store = createLocalStore();
    const a = directConversationId('a');
    const b = directConversationId('b');
    store.getState().grandfather([a], 1);
    store.getState().grandfather([b], 2);
    expect(Object.keys(store.getState().acceptedChats)).toEqual([a]);
    expect(store.getState().requestsSeeded).toBe(true);
  });
});
