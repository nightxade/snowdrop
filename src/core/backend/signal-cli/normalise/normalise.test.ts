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
  BOB_NUMBER,
  dataMessage,
  fixtures,
  GROUP_ID,
  groupInfo,
  receive,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from '../fixtures/envelopes';
import { serverReceivedAt } from '../../serverTime';
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
  it('keeps the server receive time beside the message, outside what is stored', () => {
    const { payload } = only(run(fixtures.dmText).events, 'message');
    expect(serverReceivedAt(payload)).toBe(T0 + 150);
    expect(payload).not.toHaveProperty('serverAt');
  });

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
    // Someone else's timer starts when the user reads the message, not on arrival.
    expect(payload.expiresAfterReadMs).toBe(3_600_000);
    expect(payload).not.toHaveProperty('expiresAt');
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

  it('carries the sender voice-note flag into the domain, and nothing else about audio', () => {
    const voice = {
      contentType: 'audio/aac',
      filename: null,
      id: 'v1.aac',
      size: 5_000,
      width: null,
      height: null,
      caption: null,
      uploadTimestamp: T0 - 10,
    };
    const { payload } = only(
      run(
        receive('alice', {
          dataMessage: dataMessage({
            message: '',
            attachments: [
              { ...voice, isVoiceNote: true },
              { ...voice, id: 'a2.aac', filename: 'song.aac', isVoiceNote: false },
            ],
          }),
        }),
      ).events,
      'message',
    );
    expect(payload.attachments).toEqual([
      { id: 'v1.aac', contentType: 'audio/aac', size: 5_000, voiceNote: true },
      { id: 'a2.aac', contentType: 'audio/aac', fileName: 'song.aac', size: 5_000 },
    ]);
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
  });
});

describe('normaliseReceive: polls', () => {
  const poll = (pollCreate: Record<string, unknown>) =>
    receive('alice', {
      dataMessage: dataMessage({ pollCreate, groupInfo: groupInfo() }),
    });
  const options = (n: number) => Array.from({ length: n }, (_, i) => `Option ${i}`);

  it('maps a poll to the domain poll field, not text', () => {
    const message = only(run(fixtures.poll).events, 'message').payload;
    expect(message.conversationId).toBe(GROUP);
    expect(message.body).toBe('');
    expect(message.poll).toEqual({
      question: 'Where to?',
      options: ['Crag', 'Gym'],
      allowMultiple: false,
      votes: [],
    });
  });

  it('treats a missing allowMultiple as single choice, like Signal Desktop', () => {
    const message = only(
      run(poll({ question: 'Q?', options: ['a', 'b'] })).events,
      'message',
    ).payload;
    expect(message.poll?.allowMultiple).toBe(false);
    const multi = only(
      run(poll({ question: 'Q?', options: ['a', 'b'], allowMultiple: true })).events,
      'message',
    ).payload;
    expect(multi.poll?.allowMultiple).toBe(true);
  });

  it('shows a poll Signal would refuse as an honest note, never as a poll', () => {
    for (const bad of [
      { question: '', options: ['a', 'b'] },
      { question: 'Q?', options: ['a'] },
      { question: 'Q?', options: options(11) },
      { question: 'Q?', options: ['a', ''] },
      { question: 'Q?', options: ['a', 'b'.repeat(101)] },
      { question: 'q'.repeat(201), options: ['a', 'b'] },
    ]) {
      const message = only(run(poll(bad)).events, 'message').payload;
      expect(message.poll).toBeUndefined();
      expect(message.body).toBe("This poll can't be shown.");
    }
    // At the limits it is still a poll.
    const edge = only(
      run(poll({ question: 'q'.repeat(200), options: [...options(9), 'b'.repeat(100)] })).events,
      'message',
    ).payload;
    expect(edge.poll?.options).toHaveLength(10);
  });

  it('maps a vote, naming the poll by its author and timestamp', () => {
    expect(only(run(fixtures.pollVote).events, 'pollVote').payload).toEqual({
      conversationId: GROUP,
      targetAuthorId: ALICE,
      targetSentAt: T0,
      voterId: BOB,
      optionIndexes: [1],
      voteCount: 1,
      at: T0,
      serverAt: T0 + 150,
    });
  });

  it('maps our own vote from another device to us, with each option once', () => {
    const { payload } = only(run(fixtures.syncPollVote).events, 'pollVote');
    expect(payload).toMatchObject({
      conversationId: GROUP,
      targetAuthorId: ALICE,
      voterId: SELF_ACI,
      optionIndexes: [0, 1],
      voteCount: 2,
    });
  });

  it('maps an end to the poll written by whoever sent it', () => {
    expect(only(run(fixtures.pollTerminate).events, 'pollTerminate').payload).toEqual({
      conversationId: GROUP,
      authorId: ALICE,
      targetSentAt: T0,
      at: T0 + 60,
      serverAt: T0 + 150,
    });
  });

  it('ignores a vote that names no poll author', () => {
    const payload = receive('bob', {
      dataMessage: dataMessage({
        pollVote: { targetSentTimestamp: T0, optionIndexes: [0], voteCount: 1 },
        groupInfo: groupInfo(),
      }),
    });
    expect(run(payload).events).toEqual([]);
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
      // The server's receive time, which decides whether a late edit still applies.
      serverAt: T0 + 150,
    });
    const synced = only(run(fixtures.syncSentEdit).events, 'messageEdited').payload;
    expect(synced).toMatchObject({
      conversationId: GROUP,
      authorId: SELF_ACI,
      targetSentAt: T0 + 11,
      editedAt: T0 + 30,
      serverAt: T0 + 150,
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
      serverAt: T0 + 150,
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
      at: T0 + 60,
    });
    expect(only(run(fixtures.unpin).events, 'messagePinned').payload.pinned).toBe(false);
  });

  it('also shows a "Secure session reset" line for an end-session sent from our own phone', () => {
    const { payload } = only(run(fixtures.syncEndSession).events, 'message');
    expect(payload).toMatchObject({
      id: systemMessageId(SELF_ACI, T0 + 72, 'end-session'),
      conversationId: directConversationId(BOB),
      authorId: SELF_ACI,
      kind: 'system',
      systemText: 'Secure session reset',
    });
  });

  it('turns an end-session message into a "Secure session reset" line, once per envelope', () => {
    const { payload } = only(run(fixtures.endSession).events, 'message');
    expect(payload).toMatchObject({
      id: systemMessageId(ALICE, T0 + 70, 'end-session'),
      conversationId: DM_ALICE,
      kind: 'system',
      systemText: 'Secure session reset',
    });
    expect(only(run(fixtures.endSession).events, 'message').payload.id).toBe(payload.id);
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
    // `readAt` is the sync message's own timestamp: when the other device sent it.
    expect(only(run(fixtures.readSync).events, 'readSync').payload).toEqual({
      readAt: T0,
      messages: [
        { authorId: ALICE, sentAt: T0 },
        { authorId: '+15550002222', sentAt: T0 + 5 },
      ],
    });
  });
});

describe('normaliseReceive: delete for me synced from the phone', () => {
  const deleteForMe = (body: object) =>
    receive('self', {
      syncMessage: {
        deleteForMe: {
          messageDeletes: [],
          conversationDeletes: [],
          localOnlyConversationDeletes: [],
          ...body,
        },
      },
    });
  const GROUP_THREAD = { threadGroupId: GROUP_ID };
  const msg = (authorServiceId: string, sentTimestamp: number) => ({
    authorServiceId,
    sentTimestamp,
  });

  it('maps single message deletes, by conversation, author and sent time', () => {
    const { events } = run(
      deleteForMe({
        messageDeletes: [
          {
            conversation: { threadServiceId: ALICE },
            messages: [msg(ALICE, T0), msg(SELF_ACI, T0 + 1)],
          },
          {
            conversation: GROUP_THREAD,
            messages: [{ authorE164: BOB_NUMBER, sentTimestamp: T0 + 2 }],
          },
        ],
      }),
    );
    expect(only(events, 'deleteForMe').payload).toEqual({
      messages: [
        { conversationId: DM_ALICE, authorId: ALICE, sentAt: T0 },
        { conversationId: DM_ALICE, authorId: SELF_ACI, sentAt: T0 + 1 },
        { conversationId: GROUP, authorId: BOB_NUMBER, sentAt: T0 + 2 },
      ],
      conversations: [],
    });
  });

  it('folds a PNI-addressed chat and author like any other id (the prefix is dropped)', () => {
    const { events } = run(
      deleteForMe({
        messageDeletes: [
          {
            conversation: { threadServiceId: `PNI:${ALICE}` },
            messages: [msg(`PNI:${ALICE}`, T0)],
          },
        ],
      }),
    );
    expect(only(events, 'deleteForMe').payload.messages).toEqual([
      { conversationId: DM_ALICE, authorId: ALICE, sentAt: T0 },
    ]);
  });

  it('folds an E.164 chat and author to the ids the local messages are keyed by', () => {
    const { events } = run(
      deleteForMe({
        messageDeletes: [
          {
            conversation: { threadE164: ALICE_NUMBER },
            messages: [{ authorE164: ALICE_NUMBER, sentTimestamp: T0 }],
          },
        ],
      }),
      { resolvePeer: (id) => (id === ALICE_NUMBER ? ALICE : id) },
    );
    expect(only(events, 'deleteForMe').payload.messages).toEqual([
      { conversationId: DM_ALICE, authorId: ALICE, sentAt: T0 },
    ]);
  });

  it('maps conversation deletes and local-only deletes (a full delete naming no message)', () => {
    const { events } = run(
      deleteForMe({
        conversationDeletes: [
          {
            conversation: { threadE164: ALICE_NUMBER },
            mostRecentMessages: [msg(ALICE, T0 + 3)],
            mostRecentNonExpiringMessages: [msg(ALICE, T0 + 1)],
            isFullDelete: true,
          },
          { conversation: GROUP_THREAD, mostRecentMessages: [msg(BOB, T0 + 4)] },
        ],
        localOnlyConversationDeletes: [{ conversation: { threadServiceId: BOB } }],
      }),
      { resolvePeer: (id) => (id === ALICE_NUMBER ? ALICE : id) },
    );
    expect(only(events, 'deleteForMe').payload.conversations).toEqual([
      {
        conversationId: DM_ALICE,
        mostRecent: [{ authorId: ALICE, sentAt: T0 + 3 }],
        mostRecentNonExpiring: [{ authorId: ALICE, sentAt: T0 + 1 }],
        isFullDelete: true,
      },
      {
        conversationId: GROUP,
        mostRecent: [{ authorId: BOB, sentAt: T0 + 4 }],
        mostRecentNonExpiring: [],
        isFullDelete: false,
      },
      {
        conversationId: directConversationId(BOB),
        mostRecent: [],
        mostRecentNonExpiring: [],
        isFullDelete: true,
      },
    ]);
  });

  it('drops entries that name no chat or no author, and says nothing is applied', () => {
    const { events, debug } = run(
      deleteForMe({
        messageDeletes: [
          { messages: [msg(ALICE, T0)] },
          { conversation: { threadServiceId: ALICE }, messages: [{ sentTimestamp: T0 }] },
        ],
        conversationDeletes: [{ mostRecentMessages: [msg(ALICE, T0)] }],
        localOnlyConversationDeletes: [{}],
      }),
    );
    expect(events.map((e) => e.kind)).not.toContain('deleteForMe');
    expect(debug).toContain('ignored a synced delete');
  });

  it('is not acted on when it does not come from the user’s own device', () => {
    const { events, debug } = run(
      receive('alice', {
        syncMessage: {
          deleteForMe: {
            messageDeletes: [
              { conversation: { threadServiceId: ALICE }, messages: [msg(ALICE, T0)] },
            ],
            conversationDeletes: [],
            localOnlyConversationDeletes: [],
          },
        },
      }),
    );
    expect(events.map((e) => e.kind)).not.toContain('deleteForMe');
    expect(debug).toContain('ignored a synced delete');
    expect(JSON.stringify(debug)).not.toContain(ALICE);
  });
});

describe('normaliseReceive: answers and verification synced from the phone', () => {
  const sync = (syncMessage: object) => run(receive('self', { syncMessage }));

  it.each([
    ['ACCEPT', 'accept'],
    ['UNBLOCK_AND_ACCEPT', 'unblockAndAccept'],
    ['DELETE', 'delete'],
    ['BLOCK', 'block'],
    ['BLOCK_AND_DELETE', 'blockAndDelete'],
    ['SPAM', 'spam'],
    ['BLOCK_AND_SPAM', 'blockAndSpam'],
  ])('maps a %s answer about a person', (type, answer) => {
    const { events, debug } = sync({
      messageRequestResponse: { type, threadAci: ALICE, threadE164: ALICE_NUMBER },
    });
    expect(only(events, 'messageRequestResponse').payload).toEqual({
      conversationId: DM_ALICE,
      // Both addresses were named: the number's id is offered in case that is how the chat is stored.
      alsoKnownAs: directConversationId(ALICE_NUMBER),
      answer,
      at: T0,
    });
    expect(debug).toEqual([]);
  });

  it('maps an answer about a group by its group id', () => {
    const { events } = sync({ messageRequestResponse: { type: 'SPAM', groupId: GROUP_ID } });
    expect(only(events, 'messageRequestResponse').payload).toEqual({
      conversationId: GROUP,
      answer: 'spam',
      at: T0,
    });
  });

  it('addresses a person by number when there is no ACI, and folds it to their canonical id', () => {
    const { events } = sync({
      messageRequestResponse: { type: 'ACCEPT', threadE164: ALICE_NUMBER },
    });
    expect(only(events, 'messageRequestResponse').payload.conversationId).toBe(
      directConversationId(ALICE_NUMBER),
    );
    const folded = run(
      receive('self', {
        syncMessage: { messageRequestResponse: { type: 'ACCEPT', threadE164: ALICE_NUMBER } },
      }),
      { resolvePeer: (id) => (id === ALICE_NUMBER ? ALICE : id) },
    );
    expect(only(folded.events, 'messageRequestResponse').payload.conversationId).toBe(DM_ALICE);
  });

  it.each([
    ['an unknown type', { type: 'UNKNOWN', threadAci: ALICE }],
    ['a type from the future', { type: 'MUTE', threadAci: ALICE }],
    ['an inherited property name as the type', { type: 'constructor', threadAci: ALICE }],
    ['no type', { threadAci: ALICE }],
    ['no target', { type: 'ACCEPT' }],
  ])('ignores %s with a debug line that names no one', (_name, response) => {
    const { events, debug } = sync({ messageRequestResponse: response });
    // Nothing recognised: the usual "the directory may have changed" hint, and that is all.
    expect(events).toEqual([{ kind: 'directoryHint' }]);
    expect(debug).toContain('ignored a synced message request answer');
    expect(JSON.stringify(debug)).not.toContain(ALICE);
  });

  it.each([
    ['VERIFIED', true],
    ['DEFAULT', false],
    ['UNVERIFIED', false],
  ])('maps a %s safety number', (state, verified) => {
    const { events } = sync({
      verified: { destinationAci: ALICE, destinationNumber: ALICE_NUMBER, state },
    });
    expect(only(events, 'identityVerified').payload).toEqual({
      contactId: ALICE,
      verified,
      at: T0,
    });
  });

  it('ignores a verification with an unknown state or no one named', () => {
    for (const verified of [
      { destinationAci: ALICE, state: 'MAYBE' },
      { destinationAci: ALICE },
      { state: 'VERIFIED' },
    ]) {
      const { events, debug } = sync({ verified });
      expect(events).toEqual([{ kind: 'directoryHint' }]);
      expect(debug).toContain('ignored a synced verification');
      expect(JSON.stringify(debug)).not.toContain(ALICE);
    }
  });

  it('an older signal-cli, which never sends these, is read as before', () => {
    expect(only(run(fixtures.readSync).events, 'readSync').kind).toBe('readSync');
    expect(only(run(fixtures.contactsSync).events, 'contactsChanged').kind).toBe('contactsChanged');
    expect(run(receive('self', { syncMessage: {} })).events).toEqual([{ kind: 'directoryHint' }]);
  });
});

describe('normaliseReceive: robustness', () => {
  it.each([
    ['call', fixtures.call],
    ['story', fixtures.story],
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
      systemText: 'Safety Number with Alice has changed',
      systemAction: { kind: 'safety-number', contactId: ALICE },
    });
  });

  it('keeps the plain wording for other decrypt failures, with no button', () => {
    const payload = {
      account: SELF_NUMBER,
      exception: { message: 'No session', type: 'ProtocolNoSessionException' },
      envelope: {
        sourceNumber: '+15550001111',
        sourceUuid: ALICE,
        sourceName: 'Alice Liddell',
        sourceDevice: 1,
        timestamp: T0 + 7,
      },
    };
    const { payload: m } = only(run(payload).events, 'message');
    expect(m).toMatchObject({
      kind: 'system',
      systemText: "Couldn't decrypt a message from Alice. Check the safety number on your phone.",
    });
    expect(m.systemAction).toBeUndefined();
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

  it('runs the timer of the user’s own replayed message from server time', () => {
    const replay = receive('self', {
      sourceDevice: 2,
      serverReceivedTimestamp: T0 - 7_200_000,
      syncMessage: {
        sentMessage: {
          destination: BOB,
          destinationNumber: null,
          destinationUuid: BOB,
          ...dataMessage({ timestamp: T0 - 7_200_000, message: 'old', expiresInSeconds: 3600 }),
        },
      },
    });
    const { payload } = only(run(replay).events, 'message');
    expect(payload.expiresAt).toBe(T0 - 3_600_000);
    expect(payload).not.toHaveProperty('expiresAfterReadMs');
  });

  it('does not start the timer of a replayed message from someone else', () => {
    const replay = receive('alice', {
      serverReceivedTimestamp: T0 - 7_200_000,
      dataMessage: dataMessage({
        timestamp: T0 - 7_200_000,
        message: 'old',
        expiresInSeconds: 3600,
      }),
    });
    const { payload } = only(run(replay).events, 'message');
    expect(payload.expiresAfterReadMs).toBe(3_600_000);
    expect(payload).not.toHaveProperty('expiresAt');
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
