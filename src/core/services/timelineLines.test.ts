/**
 * The status lines for pins, profile-name changes, and the
 * user's own message-request answers: what makes one, what never does, and that
 * a replay never writes a second.
 */
import { describe, expect, it, vi } from 'vitest';
import { MockBackend } from '@/core/backend/mock';
import { decideNotification } from './NotificationService';
import {
  directConversationId,
  messageId,
  systemMessageId,
  type Contact,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { HistoryService } from './HistoryService';
import { MessageRequestService } from './MessageRequestService';
import { ReceiptBuffer } from './ReceiptBuffer';
import { SendService } from './SendService';
import { SyncService } from './SyncService';

const NOW = Date.UTC(2026, 8, 30, 15, 30);

async function setup(
  beforeStart?: (stores: ReturnType<typeof createStores>, backend: MockBackend) => void,
) {
  const scheduler = new ManualScheduler(NOW);
  const backend = new MockBackend({ seed: 7, clock: scheduler, scheduler, latencyMs: 0 });
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
  beforeStart?.(stores, backend);
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
  const history = new HistoryService({ backend, repository, stores, pageSize: 50, onError });
  const selfId = backend.world.self.id;
  const group = [...backend.world.conversations.values()].find(
    (c) => c.kind === 'group' && c.memberIds.length > 2,
  )!;
  const [ana, bo] = group.memberIds.filter((m) => m !== selfId) as [string, string];
  await history.open(group.id);
  const lines = async (id: ConversationId): Promise<Message[]> =>
    (await repository.listAfter(id, 0)).filter((m) => m.kind === 'system');
  return {
    scheduler,
    backend,
    repository,
    stores,
    sync,
    send,
    requests,
    onError,
    selfId,
    group: group.id,
    ana,
    bo,
    lines,
  };
}
type Harness = Awaited<ReturnType<typeof setup>>;

const normal = (conversationId: ConversationId, authorId: string, sentAt: number): Message => ({
  id: messageId(authorId, sentAt),
  conversationId,
  authorId,
  sentAt,
  receivedAt: sentAt,
  body: 'a message',
  ranges: [],
  attachments: [],
  reactions: [],
  status: 'read',
  kind: 'normal',
});

async function pin(h: Harness, by: string, target: Message, at: number, pinned = true) {
  h.backend.emit('messagePinned', {
    conversationId: target.conversationId,
    targetAuthorId: target.authorId,
    targetSentAt: target.sentAt,
    pinned,
    by,
    at,
  });
  await h.sync.idle();
}

describe('the pinned-message line', () => {
  it('says who pinned, with a button to the message, once even when replayed', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    await pin(h, h.bo, target, NOW + 20);
    await pin(h, h.bo, target, NOW + 20);
    const lines = (await h.lines(h.group)).filter((m) => m.id.endsWith(':sys:pin'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      id: systemMessageId(h.bo, NOW + 20, 'pin'),
      systemAction: { kind: 'go-to-message', messageId: target.id },
    });
    expect(lines[0]!.systemText).toMatch(/ pinned a message$/);
    expect(lines[0]!.systemText).not.toMatch(/^You /);
  });

  it('says "You pinned a message" for a pin from the user’s own phone', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    await pin(h, h.selfId, target, NOW + 20);
    const line = (await h.lines(h.group)).find((m) => m.id.endsWith(':sys:pin'));
    expect(line?.systemText).toBe('You pinned a message');
  });

  it('writes nothing for an unpin, or for a pin whose message is not stored', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    await pin(h, h.bo, target, NOW + 20, false);
    await pin(h, h.bo, normal(h.group, h.ana, NOW + 99), NOW + 30);
    expect((await h.lines(h.group)).filter((m) => m.id.endsWith(':sys:pin'))).toHaveLength(0);
  });

  it('writes the line for the user’s own pin from this device, read, once', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    expect(await h.send.pin(h.group, target, true)).toBe(true);
    const line = (await h.lines(h.group)).find((m) => m.id.endsWith(':sys:pin'));
    expect(line).toMatchObject({
      authorId: h.selfId,
      systemText: 'You pinned a message',
      systemAction: { kind: 'go-to-message', messageId: target.id },
    });
    await h.send.pin(h.group, target, false);
    expect((await h.lines(h.group)).filter((m) => m.id.endsWith(':sys:pin'))).toHaveLength(1);
  });
});

describe('pin lines that are not written', () => {
  it('writes none when the target is in another chat, or has been deleted', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    const elsewhere = directConversationId(h.bo);
    await pin(h, h.bo, { ...target, conversationId: elsewhere }, NOW + 20);
    h.backend.emit('messageDeleted', {
      conversationId: h.group,
      authorId: h.ana,
      targetSentAt: target.sentAt,
    });
    await h.sync.idle();
    await pin(h, h.bo, target, NOW + 30);
    const pins = (id: ConversationId) =>
      h.lines(id).then((all) => all.filter((m) => m.id.endsWith(':sys:pin')));
    expect(await pins(elsewhere)).toHaveLength(0);
    expect(await pins(h.group)).toHaveLength(0);
  });
});

describe('profile name lines', () => {
  const contactOf = (h: Harness, id: string, extra: Partial<Contact>): Contact => {
    const {
      profileName: _p,
      profileGivenName: _g,
      number: _n,
      ...rest
    } = h.stores.contacts.getState().byId[id]!;
    return { ...rest, ...extra };
  };
  const emit = async (h: Harness, c: Contact) => {
    h.backend.emit('contactUpdated', c);
    await h.sync.idle();
  };
  const named = (h: Harness) =>
    h.lines(h.group).then((all) => all.filter((m) => m.id.includes(':sys:profile-name:')));

  it('makes no line when a name is first learned, then one when it changes', async () => {
    const h = await setup();
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A' }));
    expect(await named(h)).toHaveLength(0);
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B', avatarVersion: 5 }));
    const lines = await named(h);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      authorId: h.ana,
      systemText: 'Ana A changed their profile name to Ana B.',
    });
    // The same update again is the same line, and a stale older listing is not a change.
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B', avatarVersion: 5 }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A', avatarVersion: 2 }));
    expect(await named(h)).toHaveLength(1);
  });

  it('names a person with a saved name by it', async () => {
    const h = await setup();
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Annie' }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Annie', avatarVersion: 9 }));
    expect((await named(h))[0]?.systemText).toBe(
      'Annie changed their profile name from Ana A to Ana B.',
    );
  });

  it('writes the same change into the direct chat when it is listed, not into other chats', async () => {
    const h = await setup();
    const dm = directConversationId(h.ana);
    const listed = !!h.stores.conversations.getState().byId[dm];
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A' }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B', avatarVersion: 5 }));
    const inDm = (await h.lines(dm)).filter((m) => m.id.includes(':sys:profile-name:'));
    expect(inDm).toHaveLength(listed ? 1 : 0);
    expect(
      (await h.lines(directConversationId(h.bo))).filter((m) => m.id.includes('profile-name')),
    ).toHaveLength(0);
  });

  it('treats a difference of only whitespace or Unicode composition as no change', async () => {
    const h = await setup();
    await emit(h, contactOf(h, h.ana, { profileName: 'Zo\u00eb  Park', name: 'Zo\u00eb Park' }));
    await emit(
      h,
      contactOf(h, h.ana, {
        profileName: ' Zoe\u0308 Park ',
        name: 'Zo\u00eb Park',
        avatarVersion: 3,
      }),
    );
    await emit(
      h,
      contactOf(h, h.ana, { profileName: 'Zo\u00eb\tPark', name: 'x', avatarVersion: 4 }),
    );
    expect(await named(h)).toHaveLength(0);
  });

  it('writes one line for a change seen twice, even without a profile update time', async () => {
    const h = await setup();
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A' }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B' }));
    // A listing that goes back and forth between the two names adds no second A to B line.
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A' }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B' }));
    const texts = (await named(h)).map((m) => m.systemText);
    expect(texts.filter((t) => t === 'Ana A changed their profile name to Ana B.')).toHaveLength(1);
    expect(new Set((await named(h)).map((m) => m.id)).size).toBe(texts.length);
  });

  it('makes no line from the initial sync or the first listing', async () => {
    const h = await setup((stores, backend) => {
      // Held under another name before the listing arrives; the listing names them differently.
      for (const [id, c] of backend.world.contacts) {
        stores.contacts.getState().upsert({ ...c, id, profileName: 'Old Name' });
        c.profileName = 'New Name';
      }
    });
    expect(h.stores.contacts.getState().byId[h.ana]?.profileName).toBe('New Name');
    const all = Object.keys(h.stores.conversations.getState().byId) as ConversationId[];
    for (const id of all)
      expect((await h.lines(id)).filter((m) => m.id.includes(':sys:profile-name:'))).toHaveLength(
        0,
      );
  });

  it('neither notifies nor counts as unread, for a profile line or a pin line', async () => {
    const h = await setup();
    const unread = () => h.stores.conversations.getState().unread[h.group]?.count ?? 0;
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    const before = unread();
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana A', name: 'Ana A' }));
    await emit(h, contactOf(h, h.ana, { profileName: 'Ana B', name: 'Ana B', avatarVersion: 5 }));
    await pin(h, h.bo, target, NOW + 20);
    const lines = (await h.lines(h.group)).filter(
      (m) => m.id.includes(':sys:profile-name:') || m.id.endsWith(':sys:pin'),
    );
    expect(lines).toHaveLength(2);
    expect(unread()).toBe(before);
    for (const line of lines)
      expect(decideNotification(h.stores, line, { now: NOW, visible: false })).toBeNull();
  });
});

describe('message request answer lines', () => {
  it('writes "You accepted ..." for an accepted request, and blocked and unblocked lines', async () => {
    const h = await setup();
    const dm = h.backend.world.conversationIds.get('request-dm')!;
    const peer = h.backend.world.conversations.get(dm)!.memberIds.find((m) => m !== h.selfId)!;
    const name = h.stores.contacts.getState().byId[peer]!.name;
    await h.requests.accept(dm);
    await h.requests.block(dm);
    await h.requests.unblock(dm);
    const texts = (await h.lines(dm)).map((m) => m.systemText);
    expect(texts).toEqual([
      `You accepted ${name}'s message request`,
      'You blocked this person',
      'You unblocked this person',
    ]);
  });

  it('does not read the chat\u2019s unread messages by writing the line', async () => {
    const h = await setup();
    const dm = h.backend.world.conversationIds.get('request-dm')!;
    const before = h.stores.conversations.getState().unread[dm]?.count ?? 0;
    expect(before).toBeGreaterThan(0);
    await h.requests.accept(dm);
    expect(h.stores.conversations.getState().unread[dm]?.count).toBe(before);
  });

  it('words a group request without a name', async () => {
    const h = await setup();
    const group = h.backend.world.conversationIds.get('request-group')!;
    await h.requests.accept(group);
    expect(
      (await h.lines(group)).filter((m) => m.id.includes(':sys:request-')).map((m) => m.systemText),
    ).toEqual(['You accepted the message request']);
  });
});

describe('which lines may be the sidebar preview', () => {
  const lastOf = (stores: ReturnType<typeof createStores>, id: ConversationId) =>
    stores.conversations.getState().lastMessage[id];
  // A new engine over the same stored messages, as after a relaunch.
  async function relaunched(h: Harness) {
    const stores = createStores();
    const sync = new SyncService({
      backend: h.backend,
      repository: h.repository,
      stores,
      clock: h.scheduler,
      scheduler: h.scheduler,
      receipts: new ReceiptBuffer(),
      onError: h.onError,
    });
    await sync.start();
    return { stores, sync };
  }

  it('keeps a request answer from becoming the preview, live and after a relaunch', async () => {
    const h = await setup();
    const dm = h.backend.world.conversationIds.get('request-dm')!;
    const real = lastOf(h.stores, dm);
    expect(real?.kind).toBe('normal');
    await h.requests.accept(dm);
    await h.requests.block(dm);
    await h.requests.unblock(dm);
    expect((await h.lines(dm)).length).toBe(3);
    expect(lastOf(h.stores, dm)?.id).toBe(real?.id);
    const again = await relaunched(h);
    expect(lastOf(again.stores, dm)?.id).toBe(real?.id);
    await again.sync.stop();
  });

  it('keeps a profile-name line from becoming the preview, live and after a relaunch', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    const base = h.stores.contacts.getState().byId[h.ana]!;
    const rename = async (profileName: string, avatarVersion: number) => {
      h.backend.emit('contactUpdated', { ...base, profileName, name: profileName, avatarVersion });
      await h.sync.idle();
    };
    await rename('Ana A', 1);
    await rename('Ana B', 2);
    expect((await h.lines(h.group)).some((m) => m.id.includes(':sys:profile-name:'))).toBe(true);
    expect(lastOf(h.stores, h.group)?.id).toBe(target.id);
    const again = await relaunched(h);
    expect(lastOf(again.stores, h.group)?.id).toBe(target.id);
    await again.sync.stop();
  });

  it('lets a pin line be the preview, live and after a relaunch', async () => {
    const h = await setup();
    const target = normal(h.group, h.ana, NOW + 10);
    h.backend.deliver(target);
    await h.sync.idle();
    await pin(h, h.bo, target, NOW + 20);
    expect(lastOf(h.stores, h.group)?.id).toBe(systemMessageId(h.bo, NOW + 20, 'pin'));
    const again = await relaunched(h);
    expect(lastOf(again.stores, h.group)?.id).toBe(systemMessageId(h.bo, NOW + 20, 'pin'));
    await again.sync.stop();
  });
});
