import { describe, expect, it } from 'vitest';
import {
  MAX_BODY_RANGES,
  directConversationId,
  groupConversationId,
  messageId,
  systemMessageId,
} from '@/core/domain';
import { createMemoryStorage } from '@/core/persistence';
import {
  ALICE,
  ALICE_NUMBER,
  BOB,
  dataMessage,
  fixtures,
  GROUP_ID,
  receive,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from '../fixtures/envelopes';
import { DirectPeers } from '../peers';
import { describeGroupChange, toContact, toGroupConversation } from './directory';
import { wireContact, wireGroup } from '../wire';
import { decodeOrThrow } from '../validate';
import { normaliseReceive } from './envelope';
import { toBodyRanges } from './ranges';
import type { AdapterEvent, NormaliseContext } from './types';

const NOW = T0 + 1_000;
const GROUP = groupConversationId(GROUP_ID);
const DM_ALICE = directConversationId(ALICE);

function ctx(overrides: Partial<NormaliseContext> = {}) {
  const debug: unknown[] = [];
  const context: NormaliseContext = {
    selfId: SELF_ACI,
    selfAliases: new Set([SELF_ACI, SELF_NUMBER]),
    resolvePeer: (id) => id,
    now: NOW,
    nameOf: (id) => ({ [ALICE]: 'Alice', [BOB]: 'Bob' })[id],
    debug: (message) => debug.push(message),
    ...overrides,
  };
  return { context, debug };
}

function run(payload: unknown, overrides?: Partial<NormaliseContext>) {
  const { context, debug } = ctx(overrides);
  return { events: normaliseReceive(payload, context), debug };
}

function only<K extends AdapterEvent['kind']>(events: AdapterEvent[], kind: K) {
  expect(events.map((e) => e.kind)).toEqual([kind]);
  return events[0] as Extract<AdapterEvent, { kind: K }>;
}

describe('normaliseReceive: messages', () => {
  it('maps an incoming DM with text styles', () => {
    const { payload } = only(run(fixtures.dmText).events, 'message');
    expect(payload).toEqual({
      id: messageId(ALICE, T0),
      conversationId: DM_ALICE,
      authorId: ALICE,
      sentAt: T0,
      receivedAt: NOW,
      body: 'hello there',
      ranges: [{ start: 6, length: 5, style: 'bold' }],
      attachments: [],
      reactions: [],
      status: 'read',
      kind: 'normal',
    });
  });

  it('maps group mentions to U+FFFC ranges (self number → ACI), clamps and drops bad styles', () => {
    const { payload } = only(run(fixtures.groupMention).events, 'message');
    expect(payload.conversationId).toBe(GROUP);
    expect(payload.body.charAt(4)).toBe('￼');
    expect(payload.ranges).toEqual([
      { start: 4, length: 1, mentionId: SELF_ACI },
      { start: 7, length: 12, style: 'italic' },
      { start: 12, length: 4, style: 'spoiler' },
    ]);
    // Timer runs from the server's receive time, not from when we saw it.
    expect(payload.expiresAt).toBe(T0 + 150 + 3_600_000);
  });

  it('accepts CLI-style "start:length:STYLE" text styles', () => {
    const { payload } = only(run(fixtures.textStyleStrings).events, 'message');
    expect(payload.ranges).toEqual([
      { start: 0, length: 4, style: 'monospace' },
      { start: 9, length: 6, style: 'strikethrough' },
    ]);
  });

  it('maps quotes with their styles and mentions', () => {
    const { payload } = only(run(fixtures.quoteReply).events, 'message');
    expect(payload.quote).toEqual({
      authorId: ALICE,
      sentAt: T0 - 60_000,
      text: 'meet at ￼ at 6?',
      ranges: [
        { start: 8, length: 1, mentionId: SELF_ACI },
        { start: 10, length: 4, style: 'bold' },
      ],
    });
  });

  it('describes a quoted attachment without text and resolves our own id', () => {
    const { payload } = only(run(fixtures.quoteOfAttachment).events, 'message');
    expect(payload.quote).toEqual({
      authorId: SELF_ACI,
      sentAt: T0 - 1,
      text: 'Photo',
      attachments: [{ contentType: 'image/jpeg' }],
    });
  });

  it('maps attachments without resolving URLs (lazy download)', () => {
    const { payload } = only(run(fixtures.attachments).events, 'message');
    expect(payload.body).toBe('');
    expect(payload.attachments).toEqual([
      {
        id: 'Zx9aB1cD2eF3.jpg',
        contentType: 'image/jpeg',
        fileName: 'crag.jpg',
        size: 482_113,
        width: 1600,
        height: 1200,
      },
      {
        id: 'Qq8rS7tU6vW5.pdf',
        contentType: 'application/pdf',
        fileName: 'topo.pdf',
        size: 1_024_000,
      },
    ]);
  });

  it('maps custom emoji delivered with the message (patches/signal-cli extension)', () => {
    const { payload } = only(run(fixtures.customEmojiDelivery).events, 'message');
    expect(payload.body).toBe('nice climb :party:');
    expect(payload.customEmoji).toEqual([
      {
        name: 'party',
        attachment: {
          id: 'Aa1Bb2Cc3Dd4.png',
          contentType: 'image/png',
          size: 4_096,
          width: 64,
          height: 64,
        },
      },
    ]);
  });

  it('drops a custom emoji entry missing its name, keeping the others', () => {
    const { payload } = only(run(fixtures.customEmojiPartiallyMalformed).events, 'message');
    expect(payload.customEmoji).toEqual([
      { name: 'b', attachment: { id: 'good.png', contentType: 'image/png' } },
    ]);
  });

  it('maps a link preview, with its image on the normal attachment path', () => {
    const { payload } = only(run(fixtures.linkPreview).events, 'message');
    expect(payload.previews).toEqual([
      {
        url: 'https://example.com/climb',
        title: 'A great climb',
        description: 'Topo and trip report.',
        image: {
          id: 'Pp1Qq2Rr3Ss4.jpg',
          contentType: 'image/jpeg',
          size: 65_536,
          width: 1200,
          height: 630,
        },
      },
    ]);
  });

  it('maps a link preview with no image, and drops one missing its url', () => {
    const { payload } = only(run(fixtures.linkPreviewNoImage).events, 'message');
    expect(payload.previews).toEqual([{ url: 'https://example.com/plain', title: 'Plain page' }]);
  });

  it('carries an updated preview on a received edit', () => {
    const { payload } = only(run(fixtures.linkPreviewEdit).events, 'messageEdited');
    expect(payload.previews).toEqual([
      { url: 'https://example.com/edited', title: 'Edited preview' },
    ]);
  });

  it('maps sync transcripts to our own messages in the right conversation', () => {
    const dm = only(run(fixtures.syncSentDm).events, 'message').payload;
    expect(dm).toMatchObject({
      id: messageId(SELF_ACI, T0 + 10),
      conversationId: directConversationId(BOB),
      authorId: SELF_ACI,
      body: 'sent from my phone',
      status: 'sent',
    });
    const group = only(run(fixtures.syncSentGroup).events, 'message').payload;
    expect(group).toMatchObject({
      conversationId: GROUP,
      authorId: SELF_ACI,
      body: 'to the group',
    });
  });

  it('maps a sticker to the domain sticker field, not a text note', () => {
    const sticker = only(run(fixtures.sticker).events, 'message').payload;
    expect(sticker.body).toBe('');
    expect(sticker.attachments).toEqual([]);
    expect(sticker.sticker).toEqual({ packId: 'a1b2c3d4', stickerId: 3 });
  });

  it('shows unsupported content as an honest italic note', () => {
    const viewOnce = only(run(fixtures.viewOnce).events, 'message').payload;
    expect(viewOnce.attachments).toEqual([]);
    expect(viewOnce.body).toContain('View-once');

    const poll = only(run(fixtures.poll).events, 'message').payload;
    expect(poll.body).toBe('Poll: Where to?\n• Crag\n• Gym\nVote on your phone.');
    expect(poll.ranges).toContainEqual({ start: 0, length: 15, style: 'bold' });
  });
});

describe('normaliseReceive: actions on messages', () => {
  it('maps incoming and synced edits', () => {
    const edit = only(run(fixtures.editIncoming).events, 'messageEdited').payload;
    expect(edit).toEqual({
      conversationId: DM_ALICE,
      authorId: ALICE,
      targetSentAt: T0,
      body: 'hello there (edited)',
      ranges: [{ start: 6, length: 5, style: 'bold' }],
      editedAt: T0 + 20,
    });
    const synced = only(run(fixtures.syncSentEdit).events, 'messageEdited').payload;
    expect(synced).toMatchObject({
      conversationId: GROUP,
      authorId: SELF_ACI,
      targetSentAt: T0 + 11,
      editedAt: T0 + 30,
    });
  });

  it('maps reactions (add and remove, number-only targets)', () => {
    const add = only(run(fixtures.reactionAdd).events, 'reaction').payload;
    expect(add).toEqual({
      conversationId: GROUP,
      targetAuthorId: SELF_ACI,
      targetSentAt: T0 - 5,
      reaction: { emoji: '🎯', authorId: ALICE, at: T0 + 40 },
      remove: false,
    });
    const remove = only(run(fixtures.reactionRemove).events, 'reaction').payload;
    expect(remove).toMatchObject({
      conversationId: DM_ALICE,
      targetAuthorId: SELF_ACI,
      remove: true,
    });
  });

  it('maps remote and admin deletes', () => {
    expect(only(run(fixtures.remoteDelete).events, 'messageDeleted').payload).toEqual({
      conversationId: DM_ALICE,
      authorId: ALICE,
      targetSentAt: T0,
    });
    expect(only(run(fixtures.adminDelete).events, 'messageDeleted').payload).toEqual({
      conversationId: GROUP,
      authorId: ALICE,
      targetSentAt: T0,
      deletedBy: BOB,
    });
  });

  it('maps pin and unpin', () => {
    expect(only(run(fixtures.pin).events, 'messagePinned').payload).toEqual({
      conversationId: GROUP,
      targetAuthorId: ALICE,
      targetSentAt: T0,
      pinned: true,
      by: BOB,
    });
    expect(only(run(fixtures.unpin).events, 'messagePinned').payload.pinned).toBe(false);
  });
});

describe('normaliseReceive: conversation state', () => {
  it('turns timer changes into a timer patch plus a system line', () => {
    const { events } = run(fixtures.expirationDm);
    expect(events).toEqual([
      { kind: 'expirationChanged', conversationId: DM_ALICE, seconds: 604_800 },
      {
        kind: 'message',
        payload: expect.objectContaining({
          id: systemMessageId(ALICE, T0 + 70, 'timer'),
          kind: 'system',
          systemText: 'Alice set disappearing messages to 1 week.',
        }) as unknown,
      },
    ]);
    const off = run(fixtures.expirationOff).events;
    expect(off[0]).toEqual({ kind: 'expirationChanged', conversationId: DM_ALICE, seconds: 0 });
    expect(off[1]).toMatchObject({
      payload: { systemText: 'You turned off disappearing messages.', authorId: SELF_ACI },
    });
  });

  it('falls back to the envelope sourceName for unknown people', () => {
    const { events } = run(fixtures.expirationDm, { nameOf: () => undefined });
    expect(events[1]).toMatchObject({
      payload: { systemText: 'Alice Liddell set disappearing messages to 1 week.' },
    });
  });

  it('asks the backend to diff group updates', () => {
    expect(run(fixtures.groupUpdate).events).toEqual([
      {
        kind: 'groupChanged',
        groupId: GROUP_ID,
        conversationId: GROUP,
        actorId: BOB,
        sentAt: T0 + 80,
      },
    ]);
  });

  it('keeps a group UPDATE with text as its own message, distinct from the system line it causes', () => {
    const { events } = run(fixtures.groupUpdateWithText);
    expect(events).toEqual([
      {
        kind: 'groupChanged',
        groupId: GROUP_ID,
        conversationId: GROUP,
        actorId: BOB,
        sentAt: T0 + 95,
      },
      {
        kind: 'message',
        payload: expect.objectContaining({
          id: messageId(BOB, T0 + 95),
          body: 'also, bring snacks',
        }) as unknown,
      },
    ]);
    // The system line the backend writes for the same (author, sentAt) uses a
    // distinct, tagged id, so it can never collide with the content message above.
    expect(systemMessageId(BOB, T0 + 95, 'group')).not.toBe(messageId(BOB, T0 + 95));
  });

  it('notes group calls as system messages', () => {
    const { payload } = only(run(fixtures.groupCall).events, 'message');
    expect(payload).toMatchObject({ kind: 'system', systemText: 'Bob started a group call.' });
  });

  it('flags contact syncs', () => {
    expect(run(fixtures.contactsSync).events).toEqual([{ kind: 'contactsChanged' }]);
  });

  it('hints that the directory may have changed on a sync message it cannot read (a message request answered on the phone)', () => {
    const { events, debug } = run(receive('self', { syncMessage: {} }));
    expect(events).toEqual([{ kind: 'directoryHint' }]);
    expect(debug).toContain('unrecognised sync message');
    // A sync it does understand is not also a hint.
    expect(run(fixtures.readSync).events.map((e) => e.kind)).toEqual(['readSync']);
  });
});

describe('message-request facts from the directory', () => {
  const wire = (extra: object) =>
    decodeOrThrow(wireContact, { uuid: ALICE, number: ALICE_NUMBER, ...extra });

  it('marks a contact saved on the phone (a nickname or a contact name), not one with only a profile name', () => {
    expect(toContact(wire({ name: 'Alice Liddell' }), SELF_ACI)?.inContacts).toBe(true);
    expect(toContact(wire({ givenName: 'Alice' }), SELF_ACI)?.inContacts).toBe(true);
    expect(toContact(wire({ nickName: 'Al' }), SELF_ACI)?.inContacts).toBe(true);
    const stranger = toContact(
      wire({ profile: { givenName: 'Alice', familyName: null } }),
      SELF_ACI,
    );
    expect(stranger?.name).toBe('Alice');
    expect(stranger).not.toHaveProperty('inContacts');
  });

  it('carries profileSharing and blocked through for a contact', () => {
    const contact = toContact(wire({ name: 'A', profileSharing: true, isBlocked: true }), SELF_ACI);
    expect(contact).toMatchObject({ profileSharing: true, blocked: true });
  });

  it('carries a blocked group, and leaves an ordinary one without the flag', () => {
    const group = (extra: object) =>
      toGroupConversation(
        decodeOrThrow(wireGroup, {
          id: GROUP_ID,
          name: 'G',
          members: [{ uuid: ALICE, number: ALICE_NUMBER }],
          ...extra,
        }),
        (id) => id,
        0,
      );
    expect(group({ isBlocked: true }).blocked).toBe(true);
    expect(group({})).not.toHaveProperty('blocked');
  });
});

describe('normaliseReceive: ephemeral events', () => {
  it('maps typing in DMs and groups', () => {
    expect(only(run(fixtures.typingStarted).events, 'typing').payload).toEqual({
      conversationId: DM_ALICE,
      authorId: ALICE,
      typing: true,
    });
    expect(only(run(fixtures.typingStoppedGroup).events, 'typing').payload).toEqual({
      conversationId: GROUP,
      authorId: BOB,
      typing: false,
    });
  });

  it('drops stale typing (replayed after a reconnect)', () => {
    expect(run(fixtures.typingStarted, { now: T0 + 60_000 }).events).toEqual([]);
  });

  it('maps delivery, read and viewed receipts', () => {
    expect(only(run(fixtures.receiptDelivered).events, 'receipt').payload).toEqual({
      authorId: ALICE,
      sentAts: [T0 - 5, T0 - 4],
      type: 'delivered',
    });
    expect(only(run(fixtures.receiptRead).events, 'receipt').payload.type).toBe('read');
    expect(only(run(fixtures.receiptViewed).events, 'receipt').payload.type).toBe('viewed');
  });

  it('maps read syncs from our other devices', () => {
    expect(only(run(fixtures.readSync).events, 'readSync').payload).toEqual({
      messages: [
        { authorId: ALICE, sentAt: T0 },
        { authorId: '+15550002222', sentAt: T0 + 5 },
      ],
    });
  });
});

describe('normaliseReceive: robustness', () => {
  it.each([
    ['call', fixtures.call],
    ['story', fixtures.story],
    ['poll vote', fixtures.pollVote],
    ['profile key update', fixtures.profileKeyUpdate],
    ['exception without envelope', fixtures.exceptionOnly],
    ['malformed data message', fixtures.malformedData],
    ['not an object', 'garbage'],
    ['envelope without a source', { envelope: { timestamp: T0 } }],
    ['wrong envelope types', { envelope: { timestamp: 'x' } }],
  ])('ignores %s with a debug log', (_label, payload) => {
    const { events, debug } = run(payload);
    expect(events).toEqual([]);
    expect(debug.length).toBeGreaterThan(0);
  });

  it('keeps a message whose quote is malformed', () => {
    const { events, debug } = run(fixtures.malformedQuote);
    const { payload } = only(events, 'message');
    expect(payload.body).toBe('still here');
    expect(payload.quote).toBeUndefined();
    expect(debug).toContain('lenient decode issues');
  });
});

describe('normaliseReceive: review fixes', () => {
  it('turns an undecryptable envelope into a system line in the DM', () => {
    const payload = {
      account: SELF_NUMBER,
      exception: { message: 'Untrusted identity', type: 'UntrustedIdentityException' },
      envelope: {
        source: '+15550001111',
        sourceNumber: '+15550001111',
        sourceUuid: ALICE,
        sourceName: 'Alice Liddell',
        sourceDevice: 1,
        timestamp: T0 + 7,
        serverReceivedTimestamp: T0 + 8,
        serverDeliveredTimestamp: T0 + 9,
      },
    };
    const { payload: m } = only(run(payload).events, 'message');
    expect(m).toMatchObject({
      id: systemMessageId(ALICE, T0 + 7, 'decrypt'),
      conversationId: DM_ALICE,
      kind: 'system',
      systemText:
        "Couldn't decrypt a message from Alice. Their safety number changed — verify it on your phone.",
    });
  });

  it('judges typing staleness by the server receive time, not the sender clock', () => {
    const skewed = receive('alice', {
      timestamp: T0 + 3_600_000, // sender clock an hour ahead
      serverReceivedTimestamp: T0 - 60_000,
      typingMessage: { action: 'STARTED', timestamp: T0 + 3_600_000 },
    });
    expect(run(skewed).events).toEqual([]);
    const fresh = receive('alice', {
      timestamp: T0 - 3_600_000, // sender clock an hour behind
      serverReceivedTimestamp: NOW - 1_000,
      typingMessage: { action: 'STARTED', timestamp: T0 - 3_600_000 },
    });
    expect(run(fresh).events.map((e) => e.kind)).toEqual(['typing']);
  });

  it('drops the timer to server time so replayed messages are already due', () => {
    const replay = receive('alice', {
      serverReceivedTimestamp: T0 - 7_200_000,
      dataMessage: dataMessage({
        timestamp: T0 - 7_200_000,
        message: 'old',
        expiresInSeconds: 3600,
      }),
    });
    const { payload } = only(run(replay).events, 'message');
    expect(payload.expiresAt).toBe(T0 - 3_600_000);
  });

  it('(regression) does not fork a DM when a peer is later addressed by their other identifier', () => {
    const peers = new DirectPeers(createMemoryStorage(), 'self');
    const resolvePeer = (id: string) => peers.resolve(id);

    // First message: Alice is addressed by number only (an older-style
    // wrapper, or simply what the daemon reported first).
    const byNumber = {
      account: SELF_NUMBER,
      envelope: {
        sourceNumber: ALICE_NUMBER,
        timestamp: T0,
        serverReceivedTimestamp: T0 + 1,
        dataMessage: dataMessage({ message: 'hi, by number' }),
      },
    };
    const first = only(run(byNumber, { resolvePeer }).events, 'message');
    expect(first.payload.conversationId).toBe(directConversationId(ALICE_NUMBER));
    peers.touch(ALICE_NUMBER, T0);

    // The daemon (or a contact listing) later reveals Alice's ACI alongside
    // her number — e.g. the envelope above's `account` learning, or a sync.
    peers.learnPair(ALICE, ALICE_NUMBER);

    // A later message addresses her by ACI only: without resolution this
    // would land in a brand-new `dm:<aci>` conversation.
    const byAci = {
      account: SELF_NUMBER,
      envelope: {
        sourceUuid: ALICE,
        timestamp: T0 + 10,
        serverReceivedTimestamp: T0 + 11,
        dataMessage: dataMessage({ timestamp: T0 + 10, message: 'hi, by aci' }),
      },
    };
    const second = only(run(byAci, { resolvePeer }).events, 'message');
    expect(second.payload.conversationId).toBe(directConversationId(ALICE_NUMBER));
    expect(second.payload.authorId).toBe(ALICE_NUMBER);
  });
});

describe('describeGroupChange', () => {
  const base = {
    id: GROUP,
    kind: 'group' as const,
    title: 'A',
    memberIds: [ALICE],
    adminIds: [],
    expireTimerSec: 0,
    lastActivityAt: 0,
  };
  const nameOf = (id: string) => (id === BOB ? 'Bob' : id);

  it('names the actor when one person made the change', () => {
    expect(
      describeGroupChange(base, { ...base, title: 'B', expireTimerSec: 86_400 }, 'Alice', nameOf),
    ).toEqual([
      'Alice changed the group name to "B".',
      'Alice set disappearing messages to 1 day.',
    ]);
  });

  it('uses passive wording for batched changes by several people', () => {
    expect(
      describeGroupChange(
        base,
        { ...base, description: 'hi', memberIds: [ALICE, BOB], adminIds: [ALICE] },
        null,
        nameOf,
      ),
    ).toEqual([
      'The group description was changed.',
      'Bob joined the group.',
      `${ALICE} is now an admin.`,
    ]);
  });
});

describe('toBodyRanges limits', () => {
  it('keeps at most MAX_BODY_RANGES, mentions first', () => {
    const textStyles = Array.from({ length: 20_000 }, (_, i) => ({
      style: 'BOLD',
      start: i % 50,
      length: 1,
    }));
    const mentions = [{ uuid: ALICE, number: null, name: null, start: 0, length: 1 }];
    const ranges = toBodyRanges('x'.repeat(100), textStyles, mentions as never);
    expect(ranges).toHaveLength(MAX_BODY_RANGES);
    expect(ranges.filter((r) => r.mentionId !== undefined)).toHaveLength(1);
  });
});
