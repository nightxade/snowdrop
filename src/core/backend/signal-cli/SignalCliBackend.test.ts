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
import { createStores, selectMessageRequestState } from '@/core/stores';
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
    .reply('sendMessageRequestResponse', { timestamp: 1, results: [] })
    .reply('block', {})
    .reply('unblock', {})
    .reply('quitGroup', { timestamp: 1, results: [] })
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
  it('lists self, contacts and groups, and only shows a DM once it has activity', async () => {
    const { backend } = await connected();
    expect(await backend.getSelf()).toMatchObject({
      id: SELF_ACI,
      number: SELF_NUMBER,
      isSelf: true,
    });
    const contacts = await backend.listContacts();
    expect(contacts.map((c) => c.name)).toEqual(['Alice Liddell', 'Bob Ross']);

    // Alice and Bob both have profileSharing (Signal's "you've chatted, or
    // accepted their message request"), but neither has any recorded local
    // activity yet, so neither DM is listed — only the group (which we're a
    // current member of, regardless of whether anyone has written in it).
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

    // A brand-new incoming message from a contact with no prior activity
    // (Alice) still creates/shows her chat; Bob (still no activity) does not.
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

  it('never lists an empty profileSharing contact as a DM, however it got that flag', async () => {
    const HIDDEN = 'c3333333-3333-4333-8333-333333333333';
    const GONE = 'd4444444-4444-4444-8444-444444444444';
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .handle('listGroups', () => ({ result: [] }))
      .handle('listContacts', () => ({
        result: [
          contact(SELF_ACI, SELF_NUMBER, 'Me Myself'),
          // All profileSharing: true (the contact() fixture default) — a
          // group co-member, an accepted request, a plain synced contact —
          // none of them has ever exchanged a message with this device.
          contact(ALICE, ALICE_NUMBER, 'Alice Liddell'),
          contact(BOB, BOB_NUMBER, 'Bob Ross', { isBlocked: true }),
          contact(HIDDEN, '+15550003333', 'Hidden Helen', { isHidden: true }),
          contact(GONE, '+15550004444', 'Gone Gary', { unregistered: true }),
        ],
      }));
    const { backend } = setup({ daemon });
    await backend.connect();
    await flush();
    expect(await backend.listConversations()).toEqual([]);
    await backend.disconnect();
  });

  it('lists a contact as soon as it has live activity, deduping an alias already tracked', async () => {
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

  it('applies DM timer changes to an already-active conversation', async () => {
    const { backend } = await connected();
    // Alice must already be a real DM: a timer change alone must not
    // announce (and so list) one that isn't (see the next test).
    await backend.ingest(fixtures.dmText);
    const updates = collect(backend, 'conversationUpdated');
    await backend.ingest(fixtures.expirationDm);
    expect(updates.at(-1)).toMatchObject({
      id: directConversationId(ALICE),
      expireTimerSec: 604_800,
    });
    await backend.disconnect();
  });

  it('a timer change alone never announces (or lists) a DM with no other activity', async () => {
    const { backend } = await connected();
    const updates = collect(backend, 'conversationUpdated');
    await backend.ingest(fixtures.expirationDm);
    expect(updates).toEqual([]);
    expect(
      (await backend.listConversations()).find((c) => c.id === directConversationId(ALICE)),
    ).toBeUndefined();
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

describe('SignalCliBackend sticker retry', () => {
  const sticker = {
    packId: 'ab12',
    stickerId: 1,
    backupAttachment: { id: 'history:snapshot:5:sticker:0', contentType: 'image/webp' },
  };
  const fail = () => ({ error: { code: -1, message: 'File not found' } });

  async function stickerBackend(version: string, getSticker: () => RpcReply) {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version });
    daemon.handle('getSticker', getSticker);
    daemon.reply('registerHistoryStickerPack', {});
    const s = await connected({ daemon });
    return { ...s, daemon };
  }

  it('retries once for a live sticker, enough for a daemon that downloads the pack on the first call', async () => {
    let calls = 0;
    const { backend, daemon } = await stickerBackend('0.14.8-snowdrop-history.15', () =>
      ++calls < 2 ? fail() : { result: { data: 'aGVsbG8=' } },
    );
    expect(await backend.resolveStickerUrl({ packId: 'ab12', stickerId: 1 })).toMatch(/^blob:/u);
    expect(daemon.callsTo('getSticker')).toHaveLength(2);
    expect(daemon.callsTo('registerHistoryStickerPack')).toEqual([]);
    await backend.disconnect();
  });

  it('registers a history sticker pack, then gives a pre-0020 daemon its second call', async () => {
    let calls = 0;
    // history.15: unknown pack fails, then the pack download call still fails, then it works.
    const { backend, daemon } = await stickerBackend('0.14.8-snowdrop-history.15', () =>
      ++calls < 3 ? fail() : { result: { data: 'aGVsbG8=' } },
    );
    expect(await backend.resolveStickerUrl(sticker)).toMatch(/^blob:/u);
    expect(daemon.callsTo('getSticker')).toHaveLength(3);
    expect(daemon.callsTo('registerHistoryStickerPack')).toEqual([
      { account: SELF_ACI, id: 'history:snapshot:5:sticker:0' },
    ]);
    await backend.disconnect();
  });

  it('stays bounded and reports the first failure when the sticker never resolves', async () => {
    const { backend, daemon } = await stickerBackend('0.14.8-snowdrop-history.16', fail);
    await expect(backend.resolveStickerUrl(sticker)).rejects.toMatchObject({ code: -1 });
    expect(daemon.callsTo('getSticker')).toHaveLength(3);
    await backend.disconnect();
  });

  it('logs only the stage and kind/code when registration fails, never the id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { backend, daemon } = await stickerBackend('0.14.8-snowdrop-history.15', fail);
    daemon.handle('registerHistoryStickerPack', () => ({
      error: { code: -32000, message: 'history:snapshot:5:sticker:0 has no pack key' },
    }));
    await expect(backend.resolveStickerUrl(sticker)).rejects.toBeInstanceOf(SignalCliError);
    // Registration failed: no pointless retries.
    expect(daemon.callsTo('getSticker')).toHaveLength(1);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('sticker pack registration failed'))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('snapshot');
      expect(line).not.toContain('ab12');
    }
    warn.mockRestore();
    await backend.disconnect();
  });

  it('logs why the fetch failed and what registration did, never the ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { backend } = await stickerBackend('0.14.8-snowdrop-history.16', () => ({
      error: { code: -1, message: 'Could not find sticker with ID: 1 in pack ab12' },
    }));
    await expect(backend.resolveStickerUrl({ packId: 'ab12', stickerId: 1 })).rejects.toThrow();
    const lines = warn.mock.calls.map((c) => c.map((part) => JSON.stringify(part)).join(' '));
    const line = lines.find((l) => l.includes('sticker fetch failed'));
    expect(line).toContain('no-backup');
    expect(line).toContain('not-found');
    for (const l of lines) expect(l).not.toContain('ab12');
    warn.mockRestore();
    await backend.disconnect();
  });
});

describe('SignalCliBackend sticker packs', () => {
  const KEY = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
  const SHARE_URL = `https://signal.art/addstickers/#pack_id=ab12&pack_key=${KEY}`;
  const stickers = [
    { id: 0, emoji: '😀', contentType: 'image/webp' },
    { id: 1, emoji: null, contentType: 'image/webp' },
  ];
  const fetched = (packId: string, title: string, installed = true) => ({
    packId,
    url: SHARE_URL,
    installed,
    title,
    author: 'Someone',
    cover: stickers[1],
    stickers,
  });
  const bare = (packId: string, installed = true) => ({
    packId,
    url: SHARE_URL,
    installed,
    title: '',
    author: '',
    cover: null,
    stickers: [],
  });

  it('lists installed packs, drops the key, and leaves out uninstalled ones', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('listStickerPacks', [
      fetched('bb02', 'Zebras'),
      fetched('aa01', 'Apples'),
      fetched('cc03', 'History only', false),
    ]);
    const { backend } = await connected({ daemon });
    const packs = await backend.listStickerPacks();
    expect(packs.map((p) => p.title)).toEqual(['Apples', 'Zebras']);
    expect(packs[0]).toEqual({
      packId: 'aa01',
      title: 'Apples',
      author: 'Someone',
      cover: { stickerId: 1, emoji: '' },
      stickers: [
        { stickerId: 0, emoji: '😀' },
        { stickerId: 1, emoji: '' },
      ],
    });
    expect(JSON.stringify(packs)).not.toContain(KEY);
    expect(JSON.stringify(packs)).not.toContain('signal.art');
    expect(daemon.callsTo('getSticker')).toEqual([]);
    await backend.disconnect();
  });

  it('downloads an installed pack that was never fetched, then lists it again', async () => {
    const { daemon } = daemonWithAccount();
    let downloaded = false;
    daemon.handle('listStickerPacks', () => ({
      result: downloaded ? [fetched('aa01', 'Apples')] : [bare('aa01')],
    }));
    daemon.handle('getSticker', () => {
      downloaded = true;
      return { result: { data: 'aGVsbG8=' } };
    });
    const { backend } = await connected({ daemon });
    const packs = await backend.listStickerPacks();
    expect(packs.map((p) => p.title)).toEqual(['Apples']);
    expect(daemon.callsTo('getSticker')).toEqual([
      { account: SELF_ACI, packId: 'aa01', stickerId: 0 },
    ]);
    expect(daemon.callsTo('listStickerPacks')).toHaveLength(2);
    await backend.disconnect();
  });

  it('still downloads when the daemon throws after storing the pack (pre-0020)', async () => {
    const { daemon } = daemonWithAccount();
    let downloaded = false;
    daemon.handle('listStickerPacks', () => ({
      result: downloaded ? [fetched('aa01', 'Apples')] : [bare('aa01')],
    }));
    daemon.handle('getSticker', () => {
      downloaded = true;
      return { error: { code: -1, message: 'File not found' } };
    });
    const { backend } = await connected({ daemon });
    expect((await backend.listStickerPacks()).map((p) => p.title)).toEqual(['Apples']);
    await backend.disconnect();
  });

  it('omits a pack it cannot read instead of failing, and never installs anything', async () => {
    const { daemon } = daemonWithAccount();
    daemon.reply('listStickerPacks', [bare('aa01'), fetched('bb02', 'Zebras')]);
    daemon.handle('getSticker', () => ({ error: { code: -1, message: 'nope' } }));
    const { backend } = await connected({ daemon });
    expect((await backend.listStickerPacks()).map((p) => p.title)).toEqual(['Zebras']);
    expect(daemon.callsTo('addStickerPack')).toEqual([]);
    // A pack that can't be downloaded is tried once per session, not on every open.
    expect((await backend.listStickerPacks()).map((p) => p.title)).toEqual(['Zebras']);
    expect(daemon.callsTo('getSticker')).toHaveLength(1);
    await backend.disconnect();
  });

  it('sends a sticker as packId:stickerId with no text, honouring a quote', async () => {
    const { daemon } = daemonWithAccount();
    const { backend } = await connected({ daemon });
    await backend.send({
      conversationId: GROUP,
      body: '',
      ranges: [],
      sticker: { packId: 'aa01', stickerId: 3, emoji: '😀', url: 'data:ignored' },
      quote: { authorId: ALICE, sentAt: T0, text: 'hi' },
    });
    const [call] = daemon.callsTo('send');
    expect(call).toMatchObject({
      sticker: 'aa01:3',
      message: '',
      quoteTimestamp: T0,
      quoteAuthor: ALICE,
    });
    expect(JSON.stringify(call)).not.toContain('data:ignored');
    expect(call).not.toHaveProperty('attachment');
    await backend.disconnect();
  });

  it('refuses a malformed sticker without calling the daemon', async () => {
    const { daemon } = daemonWithAccount();
    const { backend } = await connected({ daemon });
    await expect(
      backend.send({
        conversationId: GROUP,
        body: '',
        ranges: [],
        sticker: { packId: 'not hex; --message x', stickerId: 1 },
      }),
    ).rejects.toBeInstanceOf(SignalCliError);
    expect(daemon.callsTo('send')).toEqual([]);
    await backend.disconnect();
  });
});

describe('SignalCliBackend sync-only read receipts', () => {
  async function backendAt(version: string) {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version });
    const s = await connected({ daemon });
    return { ...s, daemon };
  }

  it('asks signal-cli for syncOnly on a build with patch 0023', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.19');
    expect(backend.supportsReadSync()).toBe(true);
    await backend.markRead(GROUP, [{ authorId: ALICE, sentAt: 1 }], { syncOnly: true });
    expect(daemon.callsTo('sendReceipt')).toEqual([
      { account: SELF_ACI, recipient: ALICE, targetTimestamp: [1], type: 'read', syncOnly: true },
    ]);
    await backend.disconnect();
    expect(backend.supportsReadSync()).toBe(false);
  });

  it('never sends a sync-only read to an older build (it would be a real receipt)', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.18');
    expect(backend.supportsReadSync()).toBe(false);
    await backend.markRead(GROUP, [{ authorId: ALICE, sentAt: 1 }], { syncOnly: true });
    expect(daemon.callsTo('sendReceipt')).toEqual([]);
    await backend.markRead(GROUP, [{ authorId: ALICE, sentAt: 1 }]);
    expect(daemon.callsTo('sendReceipt')[0]).not.toHaveProperty('syncOnly');
    await backend.disconnect();
  });
});

describe('SignalCliBackend phone privacy settings', () => {
  async function backendAt(version: string) {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version });
    daemon.reply('getConfiguration', {
      readReceipts: false,
      typingIndicators: null,
      linkPreviews: true,
    });
    daemon.reply('updateConfiguration', {});
    const s = await connected({ daemon });
    return { ...s, daemon };
  }

  it('is only offered on a build with patch 0022, and never after disconnecting', async () => {
    expect((await backendAt('0.14.8-snowdrop-history.17')).backend.supportsPhonePrivacy()).toBe(
      false,
    );
    expect((await backendAt('0.14.8')).backend.supportsPhonePrivacy()).toBe(false);
    const { backend } = await backendAt('0.14.8-snowdrop-history.18');
    expect(backend.supportsPhonePrivacy()).toBe(true);
    await backend.disconnect();
    expect(backend.supportsPhonePrivacy()).toBe(false);
  });

  it('reads the stored values, keeping unknown ones as null', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.18');
    await expect(backend.readPhonePrivacy()).resolves.toEqual({
      readReceipts: false,
      typingIndicators: null,
      linkPreviews: true,
      unidentifiedDeliveryIndicators: null,
    });
    expect(daemon.callsTo('getConfiguration')).toEqual([{ account: SELF_ACI }]);
    await backend.disconnect();
  });

  it('refuses to read or write on a build without the patch, without calling the daemon', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    await expect(backend.readPhonePrivacy()).rejects.toBeInstanceOf(SignalCliError);
    await expect(backend.updatePhonePrivacy({ readReceipts: true })).rejects.toBeInstanceOf(
      SignalCliError,
    );
    expect(daemon.callsTo('getConfiguration')).toEqual([]);
    expect(daemon.callsTo('updateConfiguration')).toEqual([]);
    await backend.disconnect();
  });

  it('sends only the keys that changed', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.18');
    await backend.updatePhonePrivacy({ typingIndicators: false });
    await backend.updatePhonePrivacy({});
    expect(daemon.callsTo('updateConfiguration')).toEqual([
      { account: SELF_ACI, typingIndicators: false },
    ]);
    await backend.disconnect();
  });

  it('maps a receiveConfigurationChanged SSE event to phonePrivacyChanged', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.18');
    const changed = collect(backend, 'phonePrivacyChanged');
    daemon.lastStream!.push(
      `id:run-3\nevent:receiveConfigurationChanged\ndata:${JSON.stringify({ account: SELF_ACI })}\n\n`,
    );
    await flush();
    await backend.idle();
    expect(changed).toEqual([undefined]);
    await backend.disconnect();
  });
});

describe('SignalCliBackend installing a sticker pack from a sticker', () => {
  const KEY = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';
  const stickers = [
    { id: 0, emoji: '😀', contentType: 'image/webp' },
    { id: 1, emoji: null, contentType: 'image/webp' },
  ];
  const pack = (packId: string, installed: boolean, withStickers = true) => ({
    packId,
    url: `https://signal.art/addstickers/#pack_id=${packId}&pack_key=${KEY}`,
    installed,
    title: withStickers ? 'Winter' : '',
    author: withStickers ? 'Someone' : '',
    cover: withStickers ? stickers[1] : null,
    stickers: withStickers ? stickers : [],
  });
  const live = { packId: 'ab12', stickerId: 1 };
  const history = {
    packId: 'ab12',
    stickerId: 1,
    backupAttachment: { id: 'history:snapshot:5:sticker:0', contentType: 'image/webp' },
  };

  async function backendAt(version: string) {
    const { daemon } = daemonWithAccount();
    daemon.reply('version', { version });
    daemon.reply('getSticker', { data: 'aGVsbG8=' });
    daemon.reply('registerHistoryStickerPack', {});
    daemon.reply('installKnownStickerPack', { installed: true });
    const s = await connected({ daemon });
    return { ...s, daemon };
  }

  it('only offers installing on a build with patch 0021', async () => {
    expect(
      (await backendAt('0.14.8-snowdrop-history.16')).backend.supportsStickerPackInstall(),
    ).toBe(false);
    expect((await backendAt('0.14.8')).backend.supportsStickerPackInstall()).toBe(false);
    const { backend } = await backendAt('0.14.8-snowdrop-history.17');
    expect(backend.supportsStickerPackInstall()).toBe(true);
    await backend.disconnect();
    expect(backend.supportsStickerPackInstall()).toBe(false);
  });

  it('shows an uninstalled pack with its stickers and its install state, never the key', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    daemon.reply('listStickerPacks', [pack('ab12', false), pack('cd34', true)]);
    const details = await backend.getStickerPack(live);
    expect(details).toEqual({
      packId: 'ab12',
      title: 'Winter',
      author: 'Someone',
      installed: false,
      cover: { stickerId: 1, emoji: '' },
      stickers: [
        { stickerId: 0, emoji: '😀' },
        { stickerId: 1, emoji: '' },
      ],
    });
    expect(JSON.stringify(details)).not.toContain(KEY);
    expect(JSON.stringify(details)).not.toContain('signal.art');
    expect(daemon.callsTo('installKnownStickerPack')).toEqual([]);
    expect(daemon.callsTo('addStickerPack')).toEqual([]);
    expect((await backend.getStickerPack({ packId: 'cd34', stickerId: 0 })).installed).toBe(true);
    await backend.disconnect();
  });

  it('fetches a pack the account knows but has not downloaded, then lists it', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    let downloaded = false;
    daemon.handle('getSticker', () => {
      downloaded = true;
      return { result: { data: 'aGVsbG8=' } };
    });
    daemon.handle('listStickerPacks', () => ({
      result: [downloaded ? pack('ab12', false) : pack('ab12', false, false)],
    }));
    expect((await backend.getStickerPack(live)).title).toBe('Winter');
    await backend.disconnect();
  });

  it('registers a history sticker’s pack before showing it', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    let registered = false;
    daemon.handle('registerHistoryStickerPack', () => {
      registered = true;
      return { result: {} };
    });
    daemon.handle('getSticker', () =>
      registered
        ? { result: { data: 'aGVsbG8=' } }
        : { error: { code: -1, message: 'Could not find sticker' } },
    );
    daemon.handle('listStickerPacks', () => ({
      result: registered ? [pack('ab12', false)] : [],
    }));
    expect((await backend.getStickerPack(history)).installed).toBe(false);
    expect(daemon.callsTo('registerHistoryStickerPack')).toEqual([
      { account: SELF_ACI, id: 'history:snapshot:5:sticker:0' },
    ]);
    await backend.disconnect();
  });

  it('rejects when the pack cannot be found or fetched', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    daemon.reply('listStickerPacks', []);
    await expect(backend.getStickerPack(live)).rejects.toBeInstanceOf(SignalCliError);
    daemon.reply('listStickerPacks', [pack('ab12', false, false)]);
    daemon.handle('getSticker', () => ({ error: { code: -1, message: 'nope' } }));
    await expect(backend.getStickerPack(live)).rejects.toBeInstanceOf(SignalCliError);
    await expect(
      backend.getStickerPack({ packId: 'not hex; --x', stickerId: 0 }),
    ).rejects.toBeInstanceOf(SignalCliError);
    await backend.disconnect();
  });

  it('installs by pack id alone: the daemon looks the key up itself', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    await backend.installStickerPack(live);
    expect(daemon.callsTo('installKnownStickerPack')).toEqual([
      { account: SELF_ACI, packId: 'ab12' },
    ]);
    expect(daemon.callsTo('registerHistoryStickerPack')).toEqual([]);
    expect(daemon.callsTo('addStickerPack')).toEqual([]);
    expect(JSON.stringify(daemon.callsTo('installKnownStickerPack'))).not.toContain(KEY);
    await backend.disconnect();
  });

  it('registers a history sticker’s pack first, then installs it', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    const order: string[] = [];
    daemon.handle('registerHistoryStickerPack', () => {
      order.push('register');
      return { result: {} };
    });
    daemon.handle('installKnownStickerPack', () => {
      order.push('install');
      return { result: { installed: true } };
    });
    await backend.installStickerPack(history);
    expect(order).toEqual(['register', 'install']);
    await backend.disconnect();
  });

  it('does not install when the history registration fails', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    daemon.handle('registerHistoryStickerPack', () => ({ error: { code: -1, message: 'gone' } }));
    await expect(backend.installStickerPack(history)).rejects.toThrow();
    expect(daemon.callsTo('installKnownStickerPack')).toEqual([]);
    await backend.disconnect();
  });

  it('refuses without calling the daemon on an older build or a malformed id', async () => {
    const old = await backendAt('0.14.8-snowdrop-history.16');
    await expect(old.backend.installStickerPack(live)).rejects.toBeInstanceOf(SignalCliError);
    expect(old.daemon.callsTo('installKnownStickerPack')).toEqual([]);
    await old.backend.disconnect();
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    await expect(
      backend.installStickerPack({ packId: 'x y', stickerId: 0 }),
    ).rejects.toBeInstanceOf(SignalCliError);
    expect(daemon.callsTo('installKnownStickerPack')).toEqual([]);
    await backend.disconnect();
  });

  it('surfaces an install failure to the caller', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    daemon.handle('installKnownStickerPack', () => ({
      error: { code: -3, message: 'Could not install the sticker pack' },
    }));
    await expect(backend.installStickerPack(live)).rejects.toMatchObject({ code: -3 });
    await backend.disconnect();
  });

  it('reads an attachment’s bytes without caching a URL, and refuses a too-big one', async () => {
    const { backend, daemon } = await backendAt('0.14.8-snowdrop-history.17');
    daemon.reply('getAttachment', { data: 'aGVsbG8=' });
    const attachment = { id: 'em1.png', contentType: 'image/png', size: 5 };
    const blob = await backend.readAttachmentBlob(GROUP, attachment, { maxBytes: 100 });
    expect(blob.size).toBe(5);
    expect(blob.type).toBe('image/png');
    await expect(
      backend.readAttachmentBlob(GROUP, { ...attachment, size: 500 }, { maxBytes: 100 }),
    ).rejects.toMatchObject({ kind: 'too-large' });
    // An unadvertised size is checked after the read.
    await expect(
      backend.readAttachmentBlob(
        GROUP,
        { id: 'em2.png', contentType: 'image/png' },
        { maxBytes: 2 },
      ),
    ).rejects.toMatchObject({ kind: 'too-large' });
    expect(daemon.callsTo('getAttachment')).toHaveLength(2);
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

  it('a message the user sent from the phone to a non-contact (sync transcript) accepts that chat', async () => {
    const { backend, contacts, scheduler } = setup();
    // Bob is neither saved nor sharing a profile with the user.
    Object.assign(
      contacts.find((c) => c.uuid === BOB)!,
      {
        name: null,
        profileSharing: false,
      },
    );
    const stores = createStores();
    const repository = new MemoryMessageRepository();
    const sync = new SyncService({ backend, repository, stores, clock: scheduler, scheduler });
    await sync.start();
    await flush();
    const bob = directConversationId(BOB);
    const request = () => selectMessageRequestState(stores, bob);
    await backend.ingest(fixtures.syncSentDm);
    await flush();
    await sync.idle();
    expect(stores.conversations.getState().byId[bob]).toBeDefined();
    expect(request()).toBe('accepted');
    expect(stores.local.getState().acceptedChats[bob]).toBeDefined();
    await sync.stop();
  });

  it('drops a persisted stale peer (no real message anywhere), but keeps one once a real message is seeded', async () => {
    const { backend, storage, scheduler } = setup();
    // Bob: a peer entry persisted by the since-fixed bug that let a system
    // line alone touch and list a DM — no real message anywhere, in the
    // repository or in history (this daemon has none).
    storage.setItem(
      `snowdrop.signal-cli.peers.${SELF_ACI}`,
      JSON.stringify({ peers: { [BOB]: T0 }, aliases: {} }),
    );
    const stores = createStores();
    const repository = new MemoryMessageRepository();
    const sync = new SyncService({ backend, repository, stores, clock: scheduler, scheduler });
    await sync.start();
    await flush();
    expect(stores.conversations.getState().byId[directConversationId(BOB)]).toBeUndefined();

    // Alice: a real message arrives live — the same repository check that
    // dropped Bob confirms her instead, once her message is stored.
    await backend.ingest(fixtures.dmText);
    await flush();
    await sync.idle();
    expect(stores.conversations.getState().byId[directConversationId(ALICE)]).toMatchObject({
      title: 'Alice Liddell',
    });
    await sync.stop();
  });

  it("a system line after a real message never moves its DM up, and doesn't un-drop a stale one", async () => {
    const { backend, scheduler } = setup();
    const stores = createStores();
    const repository = new MemoryMessageRepository();
    const sync = new SyncService({ backend, repository, stores, clock: scheduler, scheduler });
    await sync.start();
    await flush();
    await backend.ingest(fixtures.dmText); // Alice: a real message, sentAt T0.
    await flush();
    await sync.idle();
    const before =
      stores.conversations.getState().byId[directConversationId(ALICE)]?.lastActivityAt;
    expect(before).toBe(T0);
    // A later timer change (sentAt T0 + 70, newer than Alice's real
    // message) is still just a system line: it must not move her up.
    await backend.ingest(fixtures.expirationDm);
    await flush();
    await sync.idle();
    expect(stores.conversations.getState().byId[directConversationId(ALICE)]?.lastActivityAt).toBe(
      before,
    );
    await sync.stop();
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

  it('lists a history-only chat only if it has a real message (not just system entries), carrying the phone archived hint', async () => {
    const CAROL = 'c6666666-6666-4666-8666-666666666666';
    const DINAH = 'd7777777-7777-4777-8777-777777777777';
    const EVAN = 'e8888888-8888-4888-8888-888888888888';
    const recipient = (cursor: string, id: string, aci: string, name: string) => ({
      cursor,
      frame: {
        recipient: {
          id,
          contact: {
            aci: Buffer.from(aci.replaceAll('-', ''), 'hex').toString('base64'),
            profileGivenName: name,
          },
        },
      },
    });
    const daemon = new FakeDaemon()
      .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
      .handle('listGroups', () => ({ result: [] }))
      .handle('listContacts', () => ({ result: [] }));
    daemon.reply('getHistoryDirectory', {
      archiveId: 'snapshot',
      entries: [
        { cursor: '1', frame: { recipient: { id: '1', self: {} } } },
        recipient('2', '2', CAROL, 'Carol'),
        recipient('3', '3', DINAH, 'Dinah'),
        // Carol's chat: archived on the phone, and has a message below.
        { cursor: '4', frame: { chat: { id: '10', recipientId: '2', archived: true } } },
        // Dinah's chat: present in the archive, but never had a message.
        { cursor: '5', frame: { chat: { id: '11', recipientId: '3' } } },
        recipient('6', '4', EVAN, 'Evan'),
        // Evan's chat: only a system entry ("joined Signal"), no real message.
        { cursor: '7', frame: { chat: { id: '12', recipientId: '4' } } },
      ],
      nextCursor: '7',
      hasMore: false,
    });
    daemon.handle('getHistoryChat', (params) => ({
      result:
        params.chatId === '10'
          ? {
              archiveId: 'snapshot',
              entries: [
                {
                  cursor: '6',
                  frame: {
                    chatItem: {
                      chatId: '10',
                      authorId: '2',
                      dateSent: '1000',
                      incoming: { dateReceived: '1001' },
                      standardMessage: { text: { body: 'hi' } },
                    },
                  },
                },
              ],
              nextCursor: '6',
              hasMore: false,
            }
          : params.chatId === '12'
            ? {
                archiveId: 'snapshot',
                entries: [
                  {
                    cursor: '9',
                    frame: {
                      chatItem: {
                        chatId: '12',
                        authorId: '4',
                        dateSent: '2000',
                        incoming: { dateReceived: '2001' },
                        updateMessage: { simpleUpdate: { type: 'JOINED_SIGNAL' } },
                      },
                    },
                  },
                ],
                nextCursor: '9',
                hasMore: false,
              }
            : { archiveId: 'snapshot', entries: [], hasMore: false },
    }));
    const { backend } = setup({ daemon });
    await backend.connect();
    await flush();
    const conversations = await backend.listConversations();
    expect(conversations).toEqual([
      expect.objectContaining({
        id: directConversationId(CAROL),
        historyArchived: true,
        lastActivityAt: 1000, // Carol's real message's own dateSent, not 0 or her chat's system entry.
      }),
    ]);
    expect(conversations.find((c) => c.id === directConversationId(DINAH))).toBeUndefined();
    expect(conversations.find((c) => c.id === directConversationId(EVAN))).toBeUndefined();
    // Listing only does the cheap newest-message lookups, never the outgoing scan.
    expect(daemon.callsTo('getHistoryChat').every((c) => c.limit === 8)).toBe(true);
    // That scan is its own call, made on request, and cached.
    expect(await backend.historyHasOutgoing(directConversationId(CAROL))).toBe(false);
    expect(daemon.callsTo('getHistoryChat').some((c) => c.limit === 500)).toBe(true);
    const calls = daemon.callsTo('getHistoryChat').length;
    await backend.historyHasOutgoing(directConversationId(CAROL));
    expect(daemon.callsTo('getHistoryChat')).toHaveLength(calls);
    expect(await backend.historyHasOutgoing(directConversationId('nobody'))).toBe(false);
    await backend.disconnect();
  });

  it('orders a live DM and a live group by the max of their own activity and history', async () => {
    const recipient = (cursor: string, id: string, aci: string, name: string) => ({
      cursor,
      frame: {
        recipient: {
          id,
          contact: {
            aci: Buffer.from(aci.replaceAll('-', ''), 'hex').toString('base64'),
            profileGivenName: name,
          },
        },
      },
    });
    const realItem = (chatId: string, dateSent: string) => ({
      archiveId: 'snapshot',
      entries: [{ cursor: '9', frame: { chatItem: { chatId, dateSent } } }],
      nextCursor: '9',
      hasMore: false,
    });
    const { daemon } = daemonWithAccount();
    daemon.reply('getHistoryDirectory', {
      archiveId: 'snapshot',
      entries: [
        { cursor: '1', frame: { recipient: { id: '1', self: {} } } },
        recipient('2', '2', ALICE, 'Alice'),
        // Alice's chat: a real history message older than her live activity below.
        { cursor: '3', frame: { chat: { id: '10', recipientId: '2' } } },
        // The Climbing Club group (already a live member, see
        // daemonWithAccount): a real history message, but no live-received
        // message this session, so `toGroupConversation`'s own 0 would
        // otherwise leave it unordered.
        {
          cursor: '4',
          frame: {
            recipient: { id: '3', group: { snapshot: { title: { title: 'Climbing Club' } } } },
            signalGroupId: GROUP_ID,
          },
        },
        { cursor: '5', frame: { chat: { id: '11', recipientId: '3' } } },
      ],
      nextCursor: '5',
      hasMore: false,
    });
    daemon.handle('getHistoryChat', (params) => ({
      result:
        params.chatId === '10'
          ? realItem('10', '500')
          : params.chatId === '11'
            ? realItem('11', '600')
            : { archiveId: 'snapshot', entries: [], hasMore: false },
    }));
    const { backend } = setup({ daemon });
    await backend.connect();
    await flush();
    // Alice's live activity (from dmText, sentAt T0) is newer than her history (500).
    await backend.ingest(fixtures.dmText);
    const conversations = await backend.listConversations();
    expect(conversations.find((c) => c.id === directConversationId(ALICE))).toMatchObject({
      lastActivityAt: T0,
    });
    expect(conversations.find((c) => c.id === GROUP)).toMatchObject({ lastActivityAt: 600 });
    await backend.disconnect();
  });

  it('a decrypt failure or a disappearing-timer change alone never lists or bumps a DM', async () => {
    const { backend } = await connected();
    const updates = collect(backend, 'conversationUpdated');
    await backend.ingest({
      account: SELF_NUMBER,
      exception: { message: 'Untrusted identity', type: 'UntrustedIdentityException' },
      envelope: {
        source: BOB_NUMBER,
        sourceNumber: BOB_NUMBER,
        sourceUuid: BOB,
        sourceName: 'Bob Ross',
        sourceDevice: 1,
        timestamp: T0 + 7,
        serverReceivedTimestamp: T0 + 8,
        serverDeliveredTimestamp: T0 + 9,
      },
    });
    await backend.ingest(fixtures.expirationDm); // Alice: disappearing-timer change, no content.
    expect(updates).toEqual([]); // Neither system line announced a conversation.
    const conversations = await backend.listConversations();
    expect(conversations.find((c) => c.id === directConversationId(BOB))).toBeUndefined();
    expect(conversations.find((c) => c.id === directConversationId(ALICE))).toBeUndefined();
    await backend.disconnect();
  });
});

describe('SignalCliBackend: message requests', () => {
  it('accepts a direct request: sendMessageRequestResponse to the recipient, then re-reads contacts', async () => {
    const { backend, daemon, contacts } = await connected();
    const updates = collect(backend, 'contactUpdated');
    const bob = contacts.find((c) => c.uuid === BOB)!;
    Object.assign(bob, { profileSharing: false });
    await backend.listContacts();
    const before = daemon.callsTo('listContacts').length;
    await backend.respondToMessageRequest(directConversationId(BOB), 'accept');
    await flush();
    expect(daemon.callsTo('sendMessageRequestResponse')).toEqual([
      { account: SELF_ACI, recipient: [BOB], type: 'accept' },
    ]);
    expect(daemon.callsTo('listContacts').length).toBeGreaterThan(before);
    Object.assign(bob, { profileSharing: true });
    await backend.respondToMessageRequest(directConversationId(BOB), 'accept');
    await flush();
    expect(updates.at(-1)).toMatchObject({ id: BOB, profileSharing: true });
    await backend.disconnect();
  });

  it('answers a group request with the group id, and leaves the group on delete', async () => {
    const { backend, daemon } = await connected();
    await backend.respondToMessageRequest(GROUP, 'accept');
    expect(daemon.callsTo('sendMessageRequestResponse')).toEqual([
      { account: SELF_ACI, groupId: GROUP_ID, type: 'accept' },
    ]);
    expect(daemon.callsTo('quitGroup')).toEqual([]);
    await backend.respondToMessageRequest(GROUP, 'delete');
    expect(daemon.callsTo('sendMessageRequestResponse').at(-1)).toEqual({
      account: SELF_ACI,
      groupId: GROUP_ID,
      type: 'delete',
    });
    expect(daemon.callsTo('quitGroup')).toEqual([
      { account: SELF_ACI, groupId: GROUP_ID, delete: true },
    ]);
    await backend.disconnect();
  });

  it('still deletes a group request when leaving the group fails', async () => {
    const { backend, daemon } = await connected();
    daemon.handle('quitGroup', () => ({ error: { code: -32603, message: 'not a member' } }));
    await expect(backend.respondToMessageRequest(GROUP, 'delete')).resolves.toBeUndefined();
    await backend.disconnect();
  });

  it('surfaces a failed answer instead of swallowing it', async () => {
    const { backend, daemon } = await connected();
    daemon.handle('sendMessageRequestResponse', () => ({
      error: { code: -32603, message: 'boom' },
    }));
    await expect(
      backend.respondToMessageRequest(directConversationId(BOB), 'accept'),
    ).rejects.toThrow();
    await backend.disconnect();
  });

  it('never answers a request for the note to self', async () => {
    const { backend, daemon } = await connected();
    await backend.respondToMessageRequest(directConversationId(SELF_ACI), 'accept');
    expect(daemon.callsTo('sendMessageRequestResponse')).toEqual([]);
    await backend.disconnect();
  });

  it('blocks and unblocks a contact or a group, then re-reads the directory', async () => {
    const { backend, daemon } = await connected();
    const before = daemon.callsTo('listContacts').length;
    await backend.setBlocked(directConversationId(BOB), true);
    await backend.setBlocked(directConversationId(BOB), false);
    await backend.setBlocked(GROUP, true);
    await backend.setBlocked(GROUP, false);
    await flush();
    expect(daemon.callsTo('block')).toEqual([
      { account: SELF_ACI, recipient: [BOB] },
      { account: SELF_ACI, groupId: [GROUP_ID] },
    ]);
    expect(daemon.callsTo('unblock')).toEqual([
      { account: SELF_ACI, recipient: [BOB] },
      { account: SELF_ACI, groupId: [GROUP_ID] },
    ]);
    expect(daemon.callsTo('listContacts').length).toBeGreaterThan(before);
    await backend.disconnect();
  });

  it('lists a blocked group as blocked, and a blocked contact with the flag', async () => {
    const { backend, groups, contacts } = await connected();
    Object.assign(groups[0]!, { isBlocked: true });
    Object.assign(
      contacts.find((c) => c.uuid === BOB)!,
      { isBlocked: true },
    );
    await backend.setBlocked(directConversationId(BOB), true);
    await flush();
    expect((await backend.listContacts()).find((c) => c.id === BOB)?.blocked).toBe(true);
    await backend.setBlocked(GROUP, true);
    await flush();
    expect((await backend.listConversations()).find((c) => c.id === GROUP)?.blocked).toBe(true);
    await backend.disconnect();
  });

  it('re-reads contacts soon after a sync message it cannot read (the phone answered a request)', async () => {
    const { backend, daemon, scheduler } = await connected();
    const before = daemon.callsTo('listContacts').length;
    await backend.ingest(receive('self', { syncMessage: {} }));
    scheduler.advance(30_000);
    await flush();
    expect(daemon.callsTo('listContacts').length).toBeGreaterThan(before);
    await backend.disconnect();
  });
});
