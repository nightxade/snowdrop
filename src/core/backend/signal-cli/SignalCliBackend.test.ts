// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import {
  directConversationId,
  groupConversationId,
  messageId,
  systemMessageId,
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
  dataMessage,
  fixtures,
  groupInfo,
  receive,
  GROUP_ID,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from './fixtures/envelopes';
import { DIRECTORY_TTL_MS } from './directory';
import { HttpTransport } from './httpTransport';
import { SignalCliBackend } from './SignalCliBackend';
import { FakeDaemon, flush } from './testing';
import type {
  EventSubscription,
  EventSubscriptionOptions,
  RpcParams,
  RpcReply,
  SignalCliTransport,
  TransportCallOptions,
} from './transport';

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
    .reply('sendSyncRequest', {})
    .reply('getAttachment', { data: 'aGVsbG8=' })
    .reply('requestAttachmentBackfill', { accepted: true });
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

/**
 * Wraps a `FakeDaemon`-backed `HttpTransport` with a `restart()`: the HTTP
 * transport itself has none (restarting a daemon the user runs isn't
 * Snowdrop's job), but the desktop transport does — this stands in for it
 * so `SignalCliBackend`'s account recovery (`resolveAccount`) can be tested
 * without the whole Tauri IPC layer.
 */
class RestartingTransport implements SignalCliTransport {
  restartCalls = 0;
  private readonly inner: HttpTransport;

  constructor(
    daemon: FakeDaemon,
    private readonly onRestart: () => void,
  ) {
    this.inner = new HttpTransport({ baseUrl: '/signal-cli', fetch: daemon.fetch });
  }

  get resumeScope(): string {
    return this.inner.resumeScope;
  }

  get description(): string {
    return this.inner.description;
  }

  check(options: TransportCallOptions): Promise<void> {
    return this.inner.check(options);
  }

  request(
    method: string,
    params: RpcParams | undefined,
    options: TransportCallOptions,
  ): Promise<RpcReply> {
    return this.inner.request(method, params, options);
  }

  subscribe(options: EventSubscriptionOptions): EventSubscription {
    return this.inner.subscribe(options);
  }

  restart(): Promise<void> {
    this.restartCalls++;
    this.onRestart();
    return Promise.resolve();
  }
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

  it('recovers a previously-linked account signal-cli failed to load, by restarting and rechecking', async () => {
    // Simulates signal-cli's MultiAccountManager dropping the account after
    // a transient failure checking it against the server on startup: it
    // answers `listAccounts` with none, until something gives it a fresh
    // process (`restart`).
    let loaded = false;
    const daemon = new FakeDaemon()
      .handle('listAccounts', () => ({
        result: loaded ? [{ number: SELF_NUMBER, aci: SELF_ACI }] : [],
      }))
      .handle('listContacts', () => ({ result: [] }))
      .handle('listGroups', () => ({ result: [] }));
    const scheduler = new ManualScheduler(T0 + 1000);
    const transport = new RestartingTransport(daemon, () => {
      loaded = true;
    });
    const backend = new SignalCliBackend({
      baseUrl: '/signal-cli',
      account: SELF_NUMBER, // this device has linked before
      transport,
      clock: scheduler,
      scheduler,
      random: () => 0,
      storage: createMemoryStorage(),
    });
    const connectPromise = backend.connect();
    await flush();
    // The first (empty) listAccounts queued a restart-and-recheck, 2s out —
    // never an immediate "no-account".
    expect(scheduler.pending).toBe(1);
    scheduler.advance(2_000);
    await flush();
    await connectPromise;
    expect(transport.restartCalls).toBe(1);
    expect(backend.getStatus()).toBe('online');
    expect(backend.account).toBe(SELF_ACI);
    await backend.disconnect();
  });

  it('gives up as account-unavailable, never no-account, once the bounded backoff is exhausted', async () => {
    const daemon = new FakeDaemon().reply('listAccounts', []);
    const scheduler = new ManualScheduler(T0 + 1000);
    const transport = new RestartingTransport(daemon, () => {
      // Restarting never helps in this scenario (e.g. the account is really gone).
    });
    const backend = new SignalCliBackend({
      baseUrl: '/signal-cli',
      account: SELF_NUMBER,
      transport,
      clock: scheduler,
      scheduler,
      random: () => 0,
      storage: createMemoryStorage(),
    });
    const connectPromise = backend.connect().catch((e: unknown) => e);
    // The documented schedule: 2s, 5s, 15s, 30s — one restart at each step.
    for (const ms of [2_000, 5_000, 15_000, 30_000]) {
      await flush();
      scheduler.advance(ms);
    }
    await flush();
    const error = await connectPromise;
    expect(error).toMatchObject({ kind: 'account-unavailable' });
    expect(transport.restartCalls).toBe(4);
    expect(backend.getStatus()).toBe('error');
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

  it('reconnects the stream, resuming from the last event id in memory', async () => {
    const { backend, daemon, scheduler, statuses } = await connected();
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
  });

  it('persists the resume position only when acknowledged, after the events', async () => {
    const { backend, daemon, scheduler, storage } = await connected();
    const order: string[] = [];
    backend.on('message', (m) => order.push(`message:${m.sentAt}`));
    backend.on('checkpoint', (c) => order.push(`checkpoint:${c.cursor}`));
    daemon.lastStream!.push(
      `id:run-7\nevent:receive\ndata:${JSON.stringify(fixtures.dmText)}\n\n` +
        `id:run-8\nevent:receive\ndata:"not an envelope"\n\n`,
    );
    await flush();
    await backend.idle();
    expect(order).toEqual([`message:${T0}`, 'checkpoint:run-7', 'checkpoint:run-8']);
    const key = `snowdrop.signal-cli.cursor.http.${SELF_ACI}`;
    // Not acknowledged ⇒ a reload would re-deliver (never lose) these events.
    expect(storage.getItem(key)).toBeNull();
    backend.acknowledge('run-7');
    expect(storage.getItem(key)).toBe('run-7');
    await backend.disconnect();

    const again = new SignalCliBackend({
      baseUrl: '/signal-cli',
      fetch: daemon.fetch,
      storage,
      scheduler,
    });
    await again.connect();
    await flush();
    expect(daemon.lastStream!.headers.get('Last-Event-ID')).toBe('run-7');
    await again.disconnect();
  });

  it('maps a receiveCaughtUp SSE event to the caughtUp backend event', async () => {
    const { backend, daemon } = await connected();
    const caughtUp = collect(backend, 'caughtUp');
    const order: string[] = [];
    backend.on('caughtUp', () => order.push('caughtUp'));
    backend.on('checkpoint', (c) => order.push(`checkpoint:${c.cursor}`));
    daemon.lastStream!.push(
      `id:run-9\nevent:receiveCaughtUp\ndata:${JSON.stringify({ account: SELF_ACI })}\n\n`,
    );
    await flush();
    await backend.idle();
    expect(caughtUp).toEqual([undefined]);
    // No envelope to apply, but the event still advances (and can be acknowledged
    // for) the resume position like any other.
    expect(order).toEqual(['caughtUp', 'checkpoint:run-9']);
    await backend.disconnect();
  });

  it('can connect again after the stream failed fatally', async () => {
    const { daemon } = daemonWithAccount();
    daemon.eventStatuses = [400];
    const { backend, statuses } = await connected({ daemon });
    expect(statuses.at(-1)).toBe('error');
    await backend.connect();
    await flush();
    expect(statuses.at(-1)).toBe('online');
    expect(daemon.streams).toHaveLength(1);
    await backend.disconnect();
  });

  it('reports an error status when the stream is refused (e.g. unknown account)', async () => {
    const { daemon } = daemonWithAccount();
    daemon.eventStatuses = [400];
    const { backend, statuses } = await connected({ daemon });
    expect(statuses.at(-1)).toBe('error');
    await backend.disconnect();
  });

  it('detects custom-emoji support from the connected daemon version string', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.11' });
    const { backend } = await connected({ daemon });
    expect(backend.supportsCustomEmojiDelivery()).toBe(true);
    await backend.disconnect();
    // A fresh connect to a daemon that doesn't support it drops back to false.
    expect(backend.supportsCustomEmojiDelivery()).toBe(false);
  });

  it('treats a missing or unsupported version as no custom-emoji support', async () => {
    const { daemon } = daemonWithAccount();
    // No 'version' handler configured: FakeDaemon answers method-not-found.
    const { backend } = await connected({ daemon });
    expect(backend.supportsCustomEmojiDelivery()).toBe(false);
    await backend.disconnect();
  });

  it('detects attachment-backfill support from the connected daemon version string (patches/signal-cli 0016)', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.14' });
    const { backend } = await connected({ daemon });
    expect(backend.supportsAttachmentBackfill()).toBe(true);
    await backend.disconnect();
    // A fresh connect to a daemon that doesn't support it drops back to false.
    expect(backend.supportsAttachmentBackfill()).toBe(false);
  });

  it('treats an older patched build as no attachment-backfill support', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.13' });
    const { backend } = await connected({ daemon });
    expect(backend.supportsAttachmentBackfill()).toBe(false);
    await backend.disconnect();
  });
});

describe('SignalCliBackend: attachment backfill (patches/signal-cli 0016)', () => {
  it('sends requestAttachmentBackfill with the DM recipient, author, timestamp and attachment ids', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.14' });
    const { backend } = await connected({ daemon });
    const conversationId = directConversationId(ALICE);

    await backend.requestAttachmentBackfill(conversationId, ALICE, T0, ['att-1', 'att-2']);

    expect(daemon.callsTo('requestAttachmentBackfill')).toEqual([
      {
        recipient: ALICE,
        targetAuthor: ALICE,
        // A 64-bit timestamp travels as a decimal string, like other int64 RPC fields.
        targetTimestamp: String(T0),
        attachmentIds: ['att-1', 'att-2'],
        account: SELF_ACI,
      },
    ]);
    await backend.disconnect();
  });

  it('sends the group id instead of a recipient for a group conversation', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.14' });
    const { backend } = await connected({ daemon });

    await backend.requestAttachmentBackfill(GROUP, ALICE, T0, ['att-1']);

    const [call] = daemon.callsTo('requestAttachmentBackfill');
    expect(call).toMatchObject({
      groupId: GROUP_ID,
      targetAuthor: ALICE,
      targetTimestamp: String(T0),
    });
    expect(call).not.toHaveProperty('recipient');
    await backend.disconnect();
  });

  it('is a no-op against a daemon that does not support it', async () => {
    const { daemon } = daemonWithAccount();
    // No 'version' handler: supportsAttachmentBackfill() is false.
    const { backend } = await connected({ daemon });

    await backend.requestAttachmentBackfill(directConversationId(ALICE), ALICE, T0, ['att-1']);

    expect(daemon.callsTo('requestAttachmentBackfill')).toEqual([]);
    await backend.disconnect();
  });

  it('maps an attachmentBackfill SSE event to the backend event', async () => {
    const { backend, daemon } = await connected();
    const events = collect(backend, 'attachmentBackfill');
    daemon.lastStream!.push(
      `id:run-10\nevent:attachmentBackfill\ndata:${JSON.stringify({
        targetAuthor: ALICE,
        targetTimestamp: T0,
        status: 'ready',
        attachmentIds: ['att-1', 'att-2'],
      })}\n\n`,
    );
    await flush();
    await backend.idle();
    expect(events).toEqual([
      {
        targetAuthorId: ALICE,
        targetSentAt: T0,
        status: 'ready',
        attachmentIds: ['att-1', 'att-2'],
      },
    ]);
    await backend.disconnect();
  });

  it('ignores a malformed attachmentBackfill event instead of crashing the stream', async () => {
    const { backend, daemon } = await connected();
    const events = collect(backend, 'attachmentBackfill');
    daemon.lastStream!.push(`id:run-11\nevent:attachmentBackfill\ndata:${JSON.stringify({})}\n\n`);
    await flush();
    await backend.idle();
    expect(events).toEqual([]);
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

    // Alice and Bob both have profileSharing (Signal's "you've chatted, or
    // accepted their message request"), so they're listed even though
    // neither has any recorded local activity yet.
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
      expect.objectContaining({
        id: directConversationId(ALICE),
        title: 'Alice Liddell',
        expireTimerSec: 3600,
        lastActivityAt: 0,
      }),
      expect.objectContaining({
        id: directConversationId(BOB),
        title: 'Bob Ross',
        expireTimerSec: 0,
        lastActivityAt: 0,
      }),
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
    // Activity promotes Alice above her lastActivityAt-0 placement; Bob
    // (no activity) still shows up from profileSharing alone.
    const after = await backend.listConversations();
    expect(after.map((c) => c.id)).toEqual([
      GROUP,
      directConversationId(ALICE),
      directConversationId(BOB),
    ]);
    expect(after.find((c) => c.id === directConversationId(ALICE))?.lastActivityAt).toBeGreaterThan(
      0,
    );
    await backend.disconnect();
  });

  it('(regression) folds group member and admin ids to the form DM history uses', async () => {
    const s = setup();
    // Alice's DM history lives under her number (from before her ACI was known).
    s.storage.setItem(
      `snowdrop.signal-cli.peers.${SELF_ACI}`,
      JSON.stringify({ peers: { [ALICE_NUMBER]: T0 }, aliases: {} }),
    );
    s.groups[0] = group({
      members: [
        { number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true },
        { number: ALICE_NUMBER, uuid: ALICE, isAdmin: true },
      ],
      admins: [
        { number: SELF_NUMBER, uuid: SELF_ACI },
        { number: ALICE_NUMBER, uuid: ALICE },
      ],
    });
    await s.backend.connect();
    await flush();
    await s.backend.listContacts();

    const [conv] = await s.backend.listConversations();
    expect(conv?.memberIds).toEqual([SELF_ACI, ALICE_NUMBER]);
    expect(conv?.adminIds).toEqual([SELF_ACI, ALICE_NUMBER]);
    await s.backend.disconnect();
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
        id: systemMessageId(BOB, T0 + 80, 'group'),
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

  it('re-lists groups too (not just contacts) after a contacts/groups sync, announcing new ones', async () => {
    const { backend, groups, daemon } = await connected();
    const NEW_GROUP_ID = 'bmV3Z3JvdXA=';
    groups.push(
      group({
        id: NEW_GROUP_ID,
        name: 'New Group',
        members: [{ number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true }],
        admins: [{ number: SELF_NUMBER, uuid: SELF_ACI }],
      }),
    );
    const updates = collect(backend, 'conversationUpdated');
    const before = daemon.callsTo('listGroups').length;
    // A GROUPS_SYNC lands just as plausibly as a CONTACTS_SYNC right after
    // linking; either bypasses the cache TTL for both lists.
    await backend.ingest(fixtures.groupsSync);
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 1);
    expect(updates).toContainEqual(
      expect.objectContaining({ id: groupConversationId(NEW_GROUP_ID), title: 'New Group' }),
    );
    await backend.disconnect();
  });

  it('keeps re-checking groups post-connect while the count is still changing, then stops', async () => {
    const { backend, groups, daemon, scheduler } = await connected();
    const before = daemon.callsTo('listGroups').length;
    // 5s check: a new group showed up, so the chain keeps going.
    groups.push(
      group({
        id: 'bmV3MQ==',
        name: 'New 1',
        members: [{ number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true }],
      }),
    );
    scheduler.advance(5_000);
    await flush();
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 1);
    // 20s check: another new group, still changing.
    groups.push(
      group({
        id: 'bmV3Mg==',
        name: 'New 2',
        members: [{ number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true }],
      }),
    );
    scheduler.advance(15_000);
    await flush();
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 2);
    // 60s check: nothing new this time -> the chain stops.
    scheduler.advance(40_000);
    await flush();
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 3);
    // The 180s check never happens.
    scheduler.advance(120_000);
    await flush();
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 3);
    await backend.disconnect();
  });

  it('(regression) keeps checking while there are no groups yet, so a late sync still lands', async () => {
    const { backend, groups, daemon, scheduler } = await connected();
    // Freshly linked: the phone's sync hasn't arrived, so no groups at first.
    groups.splice(0);
    const updates = collect(backend, 'conversationUpdated');
    const before = daemon.callsTo('listGroups').length;
    scheduler.advance(5_000);
    await flush();
    scheduler.advance(15_000);
    await flush();
    // Two empty checks in a row must not end the chain.
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 2);
    groups.push(
      group({
        id: 'bGF0ZQ==',
        name: 'Late Group',
        members: [{ number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true }],
      }),
    );
    scheduler.advance(40_000);
    await flush();
    expect(updates).toContainEqual(
      expect.objectContaining({ id: groupConversationId('bGF0ZQ=='), title: 'Late Group' }),
    );
    await backend.disconnect();
  });

  it('lists profileSharing contacts as DMs without activity, excluding self/blocked/hidden/unregistered/un-shared', async () => {
    const HIDDEN = 'c3333333-3333-4333-8333-333333333333';
    const GONE = 'd4444444-4444-4444-8444-444444444444';
    const QUIET = 'e5555555-5555-4555-8555-555555555555';
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .handle('listGroups', () => ({ result: [] }))
      .handle('listContacts', () => ({
        result: [
          contact(SELF_ACI, SELF_NUMBER, 'Me Myself'),
          contact(ALICE, ALICE_NUMBER, 'Alice Liddell'),
          contact(BOB, BOB_NUMBER, 'Bob Ross', { isBlocked: true }),
          contact(HIDDEN, '+15550003333', 'Hidden Helen', { isHidden: true }),
          contact(GONE, '+15550004444', 'Gone Gary', { unregistered: true }),
          contact(QUIET, '+15550005555', 'No Sharing Nancy', { profileSharing: false }),
        ],
      }));
    const { backend } = setup({ daemon });
    await backend.connect();
    await flush();
    expect((await backend.listConversations()).map((c) => c.id)).toEqual([
      directConversationId(ALICE),
    ]);
    await backend.disconnect();
  });

  it('does not duplicate a profileSharing contact already tracked as an active DM under an alias', async () => {
    const s = setup();
    // Alice's recorded activity lives under her number (DirectPeers, see peers.ts).
    s.storage.setItem(
      `snowdrop.signal-cli.peers.${SELF_ACI}`,
      JSON.stringify({ peers: { [ALICE_NUMBER]: T0 }, aliases: {} }),
    );
    await s.backend.connect();
    await flush();
    const convs = await s.backend.listConversations();
    const aliceConvs = convs.filter(
      (c) => c.kind === 'direct' && c.memberIds.includes(ALICE_NUMBER),
    );
    expect(aliceConvs).toHaveLength(1);
    expect(aliceConvs[0]).toMatchObject({ lastActivityAt: T0 });
    await s.backend.disconnect();
  });

  it('syncContactsAndGroups asks the daemon to resend contacts/groups and force-re-lists', async () => {
    const { backend, daemon } = await connected();
    const beforeGroups = daemon.callsTo('listGroups').length;
    const beforeContacts = daemon.callsTo('listContacts').length;
    await backend.syncContactsAndGroups();
    expect(daemon.callsTo('sendSyncRequest')).toHaveLength(1);
    expect(daemon.callsTo('listGroups').length).toBeGreaterThan(beforeGroups);
    expect(daemon.callsTo('listContacts').length).toBeGreaterThan(beforeContacts);
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
        // Only images keep a (thumbnail) preview; never the full file.
        {
          id: expect.stringMatching(/^local:/u) as unknown,
          contentType: 'text/plain',
          fileName: 'a.txt',
          size: 2,
        },
      ],
    });
    await backend.disconnect();
  });

  it('forwards customEmoji on send/edit only when the daemon supports it', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version: '0.14.8-snowdrop-history.11' });
    const { backend } = await connected({ daemon });
    const emoji = [{ name: 'party', dataUrl: 'data:image/png;base64,aGk=' }];

    await backend.send({
      conversationId: directConversationId(ALICE),
      body: 'hi :party:',
      ranges: [],
      customEmoji: emoji,
    });
    expect(daemon.callsTo('send').at(-1)).toMatchObject({
      customEmoji: [{ name: 'party', attachment: 'data:image/png;base64,aGk=' }],
    });

    await backend.edit({
      conversationId: directConversationId(ALICE),
      targetSentAt: T0,
      body: 'hi :party: edited',
      ranges: [],
      customEmoji: emoji,
    });
    expect(daemon.callsTo('send').at(-1)).toMatchObject({
      customEmoji: [{ name: 'party', attachment: 'data:image/png;base64,aGk=' }],
    });
    await backend.disconnect();
  });

  it('never forwards customEmoji to a daemon that has not advertised support for it', async () => {
    const { backend, daemon } = await connected();
    await backend.send({
      conversationId: directConversationId(ALICE),
      body: 'hi :party:',
      ranges: [],
      customEmoji: [{ name: 'party', dataUrl: 'data:image/png;base64,aGk=' }],
    });
    expect(daemon.callsTo('send').at(-1)).not.toHaveProperty('customEmoji');
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
    expect(await backend.link.finish(uri, 'Snowdrop')).toEqual({ accountId: SELF_ACI });
    expect(daemon.callsTo('finishLink')[0]).toEqual({ deviceLinkUri: uri, deviceName: 'Snowdrop' });
    expect(daemon.callsTo('startLink')[0]).toEqual({});
    expect(onAccountSelected).toHaveBeenCalledWith(SELF_ACI);
  });

  it('preserves a successful link while reporting a failed history transfer', async () => {
    const daemon = new FakeDaemon().reply('finishLink', {
      number: SELF_NUMBER,
      aci: SELF_ACI,
      historyTransfer: 'FAILED',
    });
    const { backend, onAccountSelected } = setup({ daemon });
    const result = await backend.link.finish('sgnl://linkdevice?uuid=test', 'Snowdrop');
    expect(result.accountId).toBe(SELF_ACI);
    expect(result.historyWarning).toContain('message history could not be imported');
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
    const { backend, daemon, scheduler, storage } = setup();
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
    // The sync engine acknowledged the last event after storing it.
    expect(storage.getItem(`snowdrop.signal-cli.cursor.http.${SELF_ACI}`)).toBe('r-3');
    await sync.stop();
    expect(stores.session.getState().status).toBe('offline');
  });
});

describe('SignalCliBackend: single-account daemons', () => {
  function singleDaemon() {
    const made = daemonWithAccount();
    made.daemon.handle('listAccounts', () => ({
      error: { code: -32601, message: 'Method not implemented' },
    }));
    return made;
  }

  it('asks for the account when the daemon cannot list accounts', async () => {
    const { daemon } = singleDaemon();
    const { backend } = setup({ daemon });
    await expect(backend.connect()).rejects.toMatchObject({ kind: 'account-required' });
    expect(daemon.streams).toHaveLength(0);
  });

  it('connects without account params and learns our other identifier', async () => {
    const { daemon } = singleDaemon();
    const { backend } = await connected({ daemon, account: SELF_NUMBER });
    expect(backend.account).toBeUndefined();
    expect(daemon.streamUrls).toEqual(['/signal-cli/api/v1/events']);
    const rpcCalls = daemon.calls.filter((c) => c.method !== 'listAccounts');
    expect(rpcCalls.length).toBeGreaterThan(0);
    for (const call of rpcCalls) expect(call.params).not.toHaveProperty('account');

    // Our own sync transcript carries our ACI + number: both are "us".
    const messages = collect(backend, 'message');
    const reactions = collect(backend, 'reaction');
    await backend.ingest(fixtures.syncSentDm);
    await backend.ingest(fixtures.reactionAdd); // targets us by ACI
    expect(messages[0]?.authorId).toBe(SELF_NUMBER);
    expect(reactions[0]?.targetAuthorId).toBe(SELF_NUMBER);
    await backend.send({ conversationId: directConversationId(ALICE), body: 'x', ranges: [] });
    expect(daemon.callsTo('send').at(-1)).not.toHaveProperty('account');
    await backend.disconnect();
  });
});

describe('SignalCliBackend: directory loading', () => {
  it('opens the stream without waiting for a slow listContacts', async () => {
    const { daemon, contacts } = daemonWithAccount();
    let release: () => void = () => undefined;
    daemon.handle(
      'listContacts',
      () =>
        new Promise((resolve) => {
          release = () => {
            resolve({ result: contacts });
          };
        }),
    );
    const { backend } = setup({ daemon });
    const updated = collect(backend, 'contactUpdated');
    await backend.connect();
    await flush();
    expect(backend.getStatus()).toBe('online');
    expect(daemon.streams).toHaveLength(1);
    // Initial sync waits for the same (single) in-flight request.
    const listing = backend.listContacts();
    release();
    expect((await listing).map((c) => c.name)).toEqual(['Alice Liddell', 'Bob Ross']);
    expect(daemon.callsTo('listContacts')).toHaveLength(1);
    expect(updated.map((c) => c.name)).toContain('Alice Liddell');
    await backend.disconnect();
  });

  it('never fails the initial sync because listContacts failed', async () => {
    const { daemon } = daemonWithAccount();
    daemon.handle('listContacts', () => ({ error: { code: -3, message: 'network' } }));
    const { backend } = await connected({ daemon });
    await expect(backend.listContacts()).resolves.toEqual([]);
    await backend.disconnect();
  });

  it('re-lists groups when a message arrives for a group it does not know', async () => {
    const { backend, daemon } = await connected();
    const before = daemon.callsTo('listGroups').length;
    await backend.listConversations();
    expect(daemon.callsTo('listGroups')).toHaveLength(before); // cached (long TTL)
    await backend.ingest(
      receive('alice', {
        dataMessage: dataMessage({
          timestamp: T0 + 3,
          message: 'hi',
          groupInfo: { groupId: 'bmV3', groupName: null, revision: 1, type: 'DELIVER' },
        }),
      }),
    );
    await backend.listConversations();
    expect(daemon.callsTo('listGroups')).toHaveLength(before + 1);
    await backend.disconnect();
  });
});

describe('SignalCliBackend: group change runs', () => {
  it('describes back-to-back updates once, without misattributing them', async () => {
    const { backend, groups } = await connected();
    groups[0] = group({
      name: 'Crux Collective',
      members: [...group().members, { number: BOB_NUMBER, uuid: BOB, isAdmin: false }],
    });
    const messages = collect(backend, 'message');
    const aliceUpdate = receive('alice', {
      dataMessage: dataMessage({ timestamp: T0 + 90, groupInfo: groupInfo('UPDATE') }),
    });
    void backend.ingest(fixtures.groupUpdate);
    await backend.ingest(aliceUpdate);
    expect(messages).toEqual([
      expect.objectContaining({
        id: systemMessageId(ALICE, T0 + 90, 'group'),
        systemText: 'The group name was changed to "Crux Collective". Bob Ross joined the group.',
      }),
    ]);
    await backend.disconnect();
  });

  it('keeps a group UPDATE with text and its system line as two distinct messages', async () => {
    const { backend } = await connected();
    const messages = collect(backend, 'message');
    await backend.ingest(fixtures.groupUpdateWithText);
    expect(messages).toHaveLength(2);
    const [system, content] = messages;
    expect(system).toMatchObject({ id: systemMessageId(BOB, T0 + 95, 'group'), kind: 'system' });
    expect(content).toMatchObject({
      id: messageId(BOB, T0 + 95),
      kind: 'normal',
      body: 'also, bring snacks',
    });
    // Same author and timestamp, but distinct ids: neither was dropped by mergeDuplicate.
    expect(system?.id).not.toBe(content?.id);
    await backend.disconnect();
  });

  it('diffs against the state from when the update arrived, even after a reload', async () => {
    const { backend, groups, scheduler } = await connected();
    groups[0] = group({ name: 'Renamed' });
    const messages = collect(backend, 'message');
    // Queue the update behind a slow contacts sync, then reload groups first.
    const pending = backend.ingest(fixtures.contactsSync);
    void backend.ingest(fixtures.groupUpdate);
    scheduler.advance(DIRECTORY_TTL_MS + 1);
    await backend.listConversations();
    await pending;
    await backend.idle();
    expect(messages.map((m) => m.systemText)).toEqual([
      'Bob Ross changed the group name to "Renamed".',
    ]);
    await backend.disconnect();
  });
});

describe('SignalCliBackend: own changes and edits', () => {
  it('writes local system lines for our own conversation changes', async () => {
    const { backend } = await connected();
    const messages = collect(backend, 'message');
    await backend.updateConversation(GROUP, { title: 'New' });
    await backend.updateConversation(directConversationId(ALICE), { expireTimerSec: 60 });
    expect(messages).toEqual([
      expect.objectContaining({
        id: systemMessageId(SELF_ACI, 1, 'group'),
        kind: 'system',
        systemText: 'You changed the group name to "New".',
      }),
      expect.objectContaining({
        conversationId: directConversationId(ALICE),
        systemText: 'You set disappearing messages to 1 minute.',
      }),
    ]);
    await backend.disconnect();
  });

  it('re-sends the original quote with an edit', async () => {
    const { backend, daemon } = await connected();
    const dm = directConversationId(ALICE);
    const quote = { authorId: ALICE, sentAt: T0, text: 'hello there' };
    const { sentAt } = await backend.send({ conversationId: dm, body: 'hi', ranges: [], quote });
    await backend.edit({ conversationId: dm, targetSentAt: sentAt, body: 'hi!', ranges: [] });
    expect(daemon.callsTo('send').at(-1)).toMatchObject({
      editTimestamp: sentAt,
      quoteTimestamp: T0,
      quoteAuthor: ALICE,
      quoteMessage: 'hello there',
    });
    const other = { authorId: BOB, sentAt: 5, text: 'x' };
    await backend.edit({
      conversationId: dm,
      targetSentAt: 99,
      body: 'y',
      ranges: [],
      quote: other,
    });
    expect(daemon.callsTo('send').at(-1)).toMatchObject({ editTimestamp: 99, quoteAuthor: BOB });
    await backend.disconnect();
  });
});

describe('imported phone history', () => {
  it('loads history without emitting arrivals and explicitly starts viewed timers', async () => {
    const { backend, daemon } = setup();
    daemon.reply('getHistoryDirectory', {
      archiveId: 'snapshot',
      entries: [
        { cursor: '1', frame: { recipient: { id: '1', self: {} } } },
        {
          cursor: '2',
          frame: {
            recipient: {
              id: '2',
              contact: {
                aci: Buffer.from(ALICE.replaceAll('-', ''), 'hex').toString('base64'),
                profileGivenName: 'Archived Alice',
              },
            },
          },
        },
        { cursor: '3', frame: { chat: { id: '3', recipientId: '2' } } },
      ],
      nextCursor: '3',
      hasMore: false,
    });
    daemon.reply('getHistoryChat', {
      archiveId: 'snapshot',
      entries: [
        {
          cursor: '4',
          frame: {
            chatItem: {
              chatId: '3',
              authorId: '2',
              dateSent: '1000',
              incoming: { dateReceived: '1001' },
              expiresInMs: '5000',
              standardMessage: { text: { body: 'From the phone' } },
            },
          },
        },
      ],
      nextCursor: '4',
      hasMore: false,
    });
    const arrived = vi.fn();
    backend.on('message', arrived);
    await backend.connect();
    expect((await backend.listContacts()).find((contact) => contact.id === ALICE)?.name).toBe(
      'Alice Liddell',
    );
    const page = await backend.fetchHistory(directConversationId(ALICE), { limit: 50 });
    expect(page.messages[0]).toMatchObject({
      body: 'From the phone',
      historyCursor: 'snapshot:4',
      expiresAfterReadMs: 5000,
    });
    expect(arrived).not.toHaveBeenCalled();
    expect(daemon.callsTo('readHistory')).toEqual([]);
    daemon.reply('readHistory', [{ cursor: '4', expiresAt: '6000', unavailable: false }]);
    expect(
      await backend.readHistory([{ id: messageId(ALICE, 1000), cursor: 'snapshot:4' }]),
    ).toEqual([{ id: messageId(ALICE, 1000), expiresAt: 6000, unavailable: false }]);
    await backend.disconnect();
  });
});
