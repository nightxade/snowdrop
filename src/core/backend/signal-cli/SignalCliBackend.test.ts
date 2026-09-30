// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  directConversationId,
  groupConversationId,
  messageId,
  type ConnectionStatus,
} from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage, MemoryMessageRepository } from '@/core/persistence';
import { SyncService } from '@/core/services';
import { createStores } from '@/core/stores';
import type { BackendEvents } from '../types';
import { SignalCliError } from './errors';
import {
  ALICE,
  ALICE_NUMBER,
  BOB,
  BOB_NUMBER,
  fixtures,
  GROUP_ID,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from './fixtures/envelopes';
import { SignalCliBackend } from './SignalCliBackend';
import { FakeDaemon, flush } from './testing';

const GROUP = groupConversationId(GROUP_ID);

const contact = (uuid: string, number: string, name: string, extra: object = {}) => ({
  number,
  uuid,
  username: null,
  name,
  givenName: null,
  familyName: null,
  nickName: null,
  nickGivenName: null,
  nickFamilyName: null,
  note: null,
  color: null,
  isArchived: false,
  isBlocked: false,
  isHidden: false,
  messageExpirationTime: 0,
  profileSharing: true,
  unregistered: false,
  profile: {
    lastUpdateTimestamp: T0,
    givenName: name.split(' ')[0],
    familyName: null,
    about: null,
    aboutEmoji: null,
    hasAvatar: false,
    mobileCoinAddress: null,
  },
  ...extra,
});

const group = (overrides: object = {}) => ({
  id: GROUP_ID,
  name: 'Climbing Club',
  description: 'Weekend sends',
  isMember: true,
  isBlocked: false,
  messageExpirationTime: 0,
  members: [
    { number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true },
    { number: ALICE_NUMBER, uuid: ALICE, isAdmin: false },
  ],
  pendingMembers: [],
  requestingMembers: [],
  admins: [{ number: SELF_NUMBER, uuid: SELF_ACI }],
  banned: [],
  permissionAddMember: 'EVERY_MEMBER',
  permissionEditDetails: 'EVERY_MEMBER',
  permissionSendMessage: 'EVERY_MEMBER',
  groupInviteLink: null,
  isTerminated: false,
  ...overrides,
});

function daemonWithAccount() {
  const groups = [group()];
  const contacts = [
    contact(SELF_ACI, SELF_NUMBER, 'Me Myself'),
    contact(ALICE, ALICE_NUMBER, 'Alice Liddell', { messageExpirationTime: 3600 }),
    contact(BOB, BOB_NUMBER, 'Bob Ross'),
  ];
  const daemon = new FakeDaemon()
    .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
    .handle('listContacts', () => ({ result: contacts }))
    .handle('listGroups', (params) => ({
      result: params.groupId
        ? groups.filter((g) => (params.groupId as string[]).includes(g.id))
        : groups,
    }))
    .reply('send', { timestamp: T0 + 1000, results: [] })
    .reply('sendReaction', { timestamp: 1, results: [] })
    .reply('remoteDelete', { timestamp: 1, results: [] })
    .reply('sendAdminDelete', { timestamp: 1, results: [] })
    .reply('sendPinMessage', { timestamp: 1, results: [] })
    .reply('sendUnpinMessage', { timestamp: 1, results: [] })
    .reply('sendTyping', {})
    .reply('sendReceipt', { timestamp: 1, results: [] })
    .reply('updateGroup', { timestamp: 1, results: [] })
    .reply('updateContact', {})
    .reply('getAttachment', { data: 'aGVsbG8=' });
  return { daemon, groups, contacts };
}

function setup(options: { account?: string; daemon?: FakeDaemon } = {}) {
  const made = options.daemon
    ? { daemon: options.daemon, groups: [], contacts: [] }
    : daemonWithAccount();
  const scheduler = new ManualScheduler(T0 + 1000);
  const storage = createMemoryStorage();
  const onAccountSelected = vi.fn();
  const debug = vi.fn();
  const backend = new SignalCliBackend({
    baseUrl: '/signal-cli',
    account: options.account ?? null,
    fetch: made.daemon.fetch,
    clock: scheduler,
    scheduler,
    random: () => 0,
    storage,
    onAccountSelected,
    debug,
  });
  const statuses: ConnectionStatus[] = [];
  backend.on('status', (s) => statuses.push(s));
  return { ...made, scheduler, storage, backend, statuses, onAccountSelected, debug };
}

function collect<E extends keyof BackendEvents>(backend: SignalCliBackend, event: E) {
  const events: BackendEvents[E][] = [];
  backend.on(event, (p) => events.push(p));
  return events;
}

async function connected(options: Parameters<typeof setup>[0] = {}) {
  const s = setup(options);
  await s.backend.connect();
  await flush();
  return s;
}

describe('SignalCliBackend: connection', () => {
  it('checks the daemon, selects the account and subscribes to its events', async () => {
    const { backend, daemon, statuses, onAccountSelected } = await connected();
    expect(statuses).toEqual(['connecting', 'online']);
    expect(backend.getStatus()).toBe('online');
    expect(backend.account).toBe(SELF_ACI);
    expect(onAccountSelected).toHaveBeenCalledWith(SELF_ACI);
    expect(daemon.streamUrls).toEqual([
      `/signal-cli/api/v1/events?account=${encodeURIComponent(SELF_ACI)}`,
    ]);
    expect(daemon.callsTo('listContacts')[0]).toEqual({ allRecipients: true, account: SELF_ACI });
    await backend.disconnect();
    expect(backend.getStatus()).toBe('offline');
    expect(daemon.lastStream!.closed).toBe(true);
  });

  it('prefers the configured account (by number) in multi-account daemons', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('listAccounts', [
      { number: '+15559999999', aci: 'other-aci' },
      { number: SELF_NUMBER, aci: SELF_ACI },
    ]);
    const { backend } = await connected({ daemon, account: SELF_NUMBER });
    expect(backend.account).toBe(SELF_ACI);
    await backend.disconnect();
  });

  it('fails with no-account when nothing is linked yet', async () => {
    const daemon = new FakeDaemon().reply('listAccounts', []);
    const { backend, statuses } = setup({ daemon });
    await expect(backend.connect()).rejects.toMatchObject({ kind: 'no-account' });
    expect(statuses.at(-1)).toBe('error');
  });

  it('fails with unreachable when the daemon is down', async () => {
    const daemon = new FakeDaemon();
    daemon.up = false;
    const { backend } = setup({ daemon });
    const error: unknown = await backend.connect().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignalCliError);
    expect((error as SignalCliError).kind).toBe('unreachable');
    expect(backend.getStatus()).toBe('error');
  });

  it('reconnects the stream, resuming from the last event id, and persists it across sessions', async () => {
    const { backend, daemon, scheduler, statuses, storage } = await connected();
    daemon.lastStream!.push(
      `id:run-5\nevent:receive\ndata:${JSON.stringify(fixtures.typingStarted)}\n\n`,
    );
    await flush();
    daemon.lastStream!.end();
    await flush();
    expect(statuses.at(-1)).toBe('connecting');
    scheduler.advance(1000);
    await flush();
    expect(daemon.lastStream!.headers.get('Last-Event-ID')).toBe('run-5');
    expect(statuses.at(-1)).toBe('online');
    await backend.disconnect();

    const again = new SignalCliBackend({
      baseUrl: '/signal-cli',
      fetch: daemon.fetch,
      storage,
      scheduler,
    });
    await again.connect();
    await flush();
    expect(daemon.lastStream!.headers.get('Last-Event-ID')).toBe('run-5');
    await again.disconnect();
  });

  it('reports an error status when the stream is refused (e.g. unknown account)', async () => {
    const { daemon } = daemonWithAccount();
    daemon.eventStatuses = [400];
    const { backend, statuses } = await connected({ daemon });
    expect(statuses.at(-1)).toBe('error');
    await backend.disconnect();
  });
});

describe('SignalCliBackend: directory', () => {
  it('lists self, contacts, groups and remembered DMs', async () => {
    const { backend } = await connected();
    expect(await backend.getSelf()).toMatchObject({
      id: SELF_ACI,
      number: SELF_NUMBER,
      isSelf: true,
    });
    const contacts = await backend.listContacts();
    expect(contacts.map((c) => c.name)).toEqual(['Alice Liddell', 'Bob Ross']);

    const before = await backend.listConversations();
    expect(before).toEqual([
      {
        id: GROUP,
        kind: 'group',
        title: 'Climbing Club',
        description: 'Weekend sends',
        memberIds: [SELF_ACI, ALICE],
        adminIds: [SELF_ACI],
        expireTimerSec: 0,
        lastActivityAt: 0,
      },
    ]);

    const updates = collect(backend, 'conversationUpdated');
    await backend.ingest(fixtures.dmText);
    expect(updates).toEqual([
      expect.objectContaining({
        id: directConversationId(ALICE),
        title: 'Alice Liddell',
        expireTimerSec: 3600,
      }),
    ]);
    const after = await backend.listConversations();
    expect(after.map((c) => c.id)).toEqual([GROUP, directConversationId(ALICE)]);
    await backend.disconnect();
  });

  it('diffs group updates into conversationUpdated + a system line', async () => {
    const { backend, groups } = await connected();
    groups[0] = group({
      name: 'Crux Collective',
      members: [...group().members, { number: BOB_NUMBER, uuid: BOB, isAdmin: false }],
    });
    const updates = collect(backend, 'conversationUpdated');
    const messages = collect(backend, 'message');
    await backend.ingest(fixtures.groupUpdate);
    expect(updates[0]).toMatchObject({ id: GROUP, title: 'Crux Collective' });
    expect(messages).toEqual([
      expect.objectContaining({
        id: messageId(BOB, T0 + 80),
        kind: 'system',
        systemText:
          'Bob Ross changed the group name to "Crux Collective". Bob Ross joined the group.',
      }),
    ]);
    await backend.disconnect();
  });

  it('re-lists contacts after a contacts sync and announces changes', async () => {
    const { backend, contacts } = await connected();
    contacts[2] = contact(BOB, BOB_NUMBER, 'Robert Ross');
    const updated = collect(backend, 'contactUpdated');
    await backend.ingest(fixtures.contactsSync);
    expect(updated.map((c) => c.name)).toEqual(['Robert Ross']);
    await backend.disconnect();
  });

  it('applies DM timer changes to the conversation', async () => {
    const { backend } = await connected();
    const updates = collect(backend, 'conversationUpdated');
    await backend.ingest(fixtures.expirationDm);
    expect(updates.at(-1)).toMatchObject({
      id: directConversationId(ALICE),
      expireTimerSec: 604_800,
    });
    await backend.disconnect();
  });
});

describe('SignalCliBackend: commands', () => {
  it('sends with styles, mentions, quote and attachments; reports partial failures', async () => {
    const { backend, daemon } = await connected();
    daemon.reply('send', {
      timestamp: T0 + 5000,
      results: [
        {
          recipientAddress: { uuid: ALICE, number: ALICE_NUMBER, username: null },
          groupId: GROUP_ID,
          type: 'SUCCESS',
        },
        {
          recipientAddress: { uuid: BOB, number: BOB_NUMBER, username: null },
          groupId: GROUP_ID,
          type: 'IDENTITY_FAILURE',
        },
      ],
    });
    const result = await backend.send({
      conversationId: GROUP,
      body: 'hi ￼',
      ranges: [
        { start: 0, length: 2, style: 'bold' },
        { start: 3, length: 1, mentionId: ALICE },
      ],
      quote: { authorId: ALICE, sentAt: T0, text: 'hello there' },
      attachments: [{ fileName: 'a.txt', contentType: 'text/plain', data: new Blob(['hi']) }],
    });
    expect(daemon.callsTo('send').at(-1)).toEqual({
      account: SELF_ACI,
      groupId: GROUP_ID,
      message: 'hi ￼',
      textStyle: ['0:2:BOLD'],
      mention: [`3:1:${ALICE}`],
      attachment: ['data:text/plain;filename=a.txt;base64,aGk='],
      quoteTimestamp: T0,
      quoteAuthor: ALICE,
      quoteMessage: 'hello there',
    });
    expect(result).toMatchObject({
      sentAt: T0 + 5000,
      recipientFailures: [{ recipientId: BOB, reason: 'untrusted-identity' }],
      attachments: [
        expect.objectContaining({ fileName: 'a.txt', url: 'data:text/plain;base64,aGk=' }),
      ],
    });
    await backend.disconnect();
  });

  it('throws send-failed when a DM reached nobody, and remembers DM peers on success', async () => {
    const { backend, daemon } = await connected();
    daemon.handle('send', () => ({
      error: {
        code: -1,
        message: 'The user +15550002222 is not registered.',
        data: {
          response: {
            timestamp: 5,
            results: [
              {
                recipientAddress: { uuid: null, number: BOB_NUMBER, username: null },
                type: 'UNREGISTERED_FAILURE',
              },
            ],
          },
        },
      },
    }));
    await expect(
      backend.send({ conversationId: directConversationId(BOB_NUMBER), body: 'x', ranges: [] }),
    ).rejects.toMatchObject({
      kind: 'send-failed',
      recipientFailures: [{ recipientId: BOB_NUMBER, reason: 'unregistered' }],
    });

    daemon.reply('send', { timestamp: 9, results: [] });
    await backend.send({ conversationId: directConversationId(BOB), body: 'x', ranges: [] });
    expect((await backend.listConversations()).map((c) => c.id)).toContain(
      directConversationId(BOB),
    );
    await backend.disconnect();
  });

  it('edits, reacts, deletes, pins, types, marks read and updates groups with the right params', async () => {
    const { backend, daemon } = await connected();
    const dm = directConversationId(ALICE);
    expect(
      await backend.edit({ conversationId: dm, targetSentAt: T0, body: 'fixed', ranges: [] }),
    ).toEqual({
      sentAt: T0 + 1000,
    });
    expect(daemon.callsTo('send').at(-1)).toMatchObject({
      recipient: [ALICE],
      message: 'fixed',
      editTimestamp: T0,
    });

    await backend.react({
      conversationId: dm,
      targetAuthorId: ALICE,
      targetSentAt: T0,
      emoji: '👍',
      remove: true,
    });
    expect(daemon.callsTo('sendReaction')[0]).toEqual({
      account: SELF_ACI,
      recipient: [ALICE],
      emoji: '👍',
      targetAuthor: ALICE,
      targetTimestamp: T0,
      remove: true,
    });

    await backend.deleteForEveryone(GROUP, T0);
    expect(daemon.callsTo('remoteDelete')[0]).toMatchObject({
      groupId: GROUP_ID,
      targetTimestamp: T0,
    });

    await backend.adminDelete(GROUP, { authorId: ALICE, sentAt: T0 });
    expect(daemon.callsTo('sendAdminDelete')[0]).toMatchObject({
      groupId: GROUP_ID,
      targetAuthor: ALICE,
      targetTimestamp: T0,
    });
    await expect(backend.adminDelete(dm, { authorId: ALICE, sentAt: T0 })).rejects.toThrow(
      /only possible in groups/u,
    );

    await backend.pinMessage({
      conversationId: GROUP,
      targetAuthorId: ALICE,
      targetSentAt: T0,
      pin: true,
    });
    expect(daemon.callsTo('sendPinMessage')[0]).toMatchObject({
      pinDuration: -1,
      targetAuthor: ALICE,
    });
    await backend.pinMessage({
      conversationId: GROUP,
      targetAuthorId: ALICE,
      targetSentAt: T0,
      pin: false,
    });
    expect(daemon.callsTo('sendUnpinMessage')[0]).toMatchObject({ targetTimestamp: T0 });

    await backend.setTyping(GROUP, true);
    await backend.setTyping(dm, false);
    await backend.setTyping(directConversationId(SELF_ACI), true);
    expect(daemon.callsTo('sendTyping')).toEqual([
      { account: SELF_ACI, groupId: GROUP_ID, stop: false },
      { account: SELF_ACI, recipient: [ALICE], stop: true },
    ]);

    await backend.markRead(GROUP, [
      { authorId: ALICE, sentAt: 1 },
      { authorId: BOB, sentAt: 2 },
      { authorId: ALICE, sentAt: 3 },
      { authorId: SELF_ACI, sentAt: 4 },
    ]);
    expect(daemon.callsTo('sendReceipt')).toEqual([
      { account: SELF_ACI, recipient: ALICE, targetTimestamp: [1, 3], type: 'read' },
      { account: SELF_ACI, recipient: BOB, targetTimestamp: [2], type: 'read' },
    ]);

    const updates = collect(backend, 'conversationUpdated');
    await backend.updateConversation(GROUP, { title: 'New', expireTimerSec: 86_400 });
    expect(daemon.callsTo('updateGroup')[0]).toEqual({
      account: SELF_ACI,
      groupId: GROUP_ID,
      name: 'New',
      expiration: 86_400,
    });
    expect(updates.at(-1)).toMatchObject({ id: GROUP, title: 'New', expireTimerSec: 86_400 });
    await backend.updateConversation(dm, { expireTimerSec: 60 });
    expect(daemon.callsTo('updateContact')[0]).toMatchObject({ recipient: ALICE, expiration: 60 });
    await backend.disconnect();
  });

  it('links a new device via startLink/finishLink without an account param', async () => {
    const daemon = new FakeDaemon()
      .reply('startLink', { deviceLinkUri: 'sgnl://linkdevice?uuid=X&pub_key=Y' })
      .reply('finishLink', { number: SELF_NUMBER, aci: SELF_ACI });
    const { backend, onAccountSelected } = setup({ daemon });
    const { uri } = await backend.link.start();
    expect(uri).toBe('sgnl://linkdevice?uuid=X&pub_key=Y');
    expect(await backend.link.finish(uri, 'Hearth')).toEqual({ accountId: SELF_ACI });
    expect(daemon.callsTo('finishLink')[0]).toEqual({ deviceLinkUri: uri, deviceName: 'Hearth' });
    expect(daemon.callsTo('startLink')[0]).toEqual({});
    expect(onAccountSelected).toHaveBeenCalledWith(SELF_ACI);
  });

  it('downloads attachments lazily, once, into cached object URLs', async () => {
    const { backend, daemon } = await connected();
    const attachment = { id: 'Zx9.jpg', contentType: 'image/jpeg' };
    const [a, b] = await Promise.all([
      backend.resolveAttachmentUrl(GROUP, attachment),
      backend.resolveAttachmentUrl(GROUP, attachment),
    ]);
    expect(a).toMatch(/^blob:/u);
    expect(b).toBe(a);
    expect(await backend.resolveAttachmentUrl(GROUP, attachment)).toBe(a);
    expect(daemon.callsTo('getAttachment')).toEqual([{ account: SELF_ACI, id: 'Zx9.jpg' }]);
    expect(await backend.resolveAttachmentUrl(GROUP, { ...attachment, url: 'data:x' })).toBe(
      'data:x',
    );
    await backend.disconnect();
  });
});

describe('SignalCliBackend + SyncService', () => {
  it('delivers streamed envelopes into the stores end to end', async () => {
    const { backend, daemon, scheduler } = setup();
    const stores = createStores();
    const repository = new MemoryMessageRepository();
    const sync = new SyncService({ backend, repository, stores, clock: scheduler, scheduler });
    await sync.start();
    await flush();
    expect(stores.session.getState().self?.id).toBe(SELF_ACI);
    expect(stores.conversations.getState().byId[GROUP]?.title).toBe('Climbing Club');

    const stream = daemon.lastStream!;
    const send = (payload: unknown, id: string) => {
      stream.push(`id:${id}\nevent:receive\ndata:${JSON.stringify(payload)}\n\n`);
    };
    send(fixtures.dmText, 'r-1');
    send(fixtures.editIncoming, 'r-2');
    send(fixtures.groupMention, 'r-3');
    await flush();
    await backend.idle();
    await sync.idle();

    const dm = directConversationId(ALICE);
    expect(stores.conversations.getState().byId[dm]?.title).toBe('Alice Liddell');
    const stored = await repository.get(messageId(ALICE, T0));
    expect(stored).toMatchObject({ body: 'hello there (edited)', editedAt: T0 + 20 });
    expect(stores.conversations.getState().unread[GROUP]).toMatchObject({ count: 1, mentions: 1 });
    await sync.stop();
    expect(stores.session.getState().status).toBe('offline');
  });
});
