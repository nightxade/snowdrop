/**
 * Hand-written signal-cli `receive` payloads, shaped exactly like the Java
 * records in org.asamk.signal.json (JsonMessageEnvelope, JsonDataMessage, …)
 * as Jackson serialises them: absent optionals are explicit `null`s, except
 * fields annotated `@JsonInclude(NON_NULL)`, which are omitted.
 *
 * Test-only; nothing in the app imports this.
 */

export const SELF_ACI = 'f0000000-0000-4000-8000-000000000000';
export const SELF_NUMBER = '+15550000000';
export const ALICE = 'a1111111-1111-4111-8111-111111111111';
export const ALICE_NUMBER = '+15550001111';
export const BOB = 'b2222222-2222-4222-8222-222222222222';
export const BOB_NUMBER = '+15550002222';
export const GROUP_ID = 'Pmpi+EfPWmsxiomLe9Nx2XF9HOE483p6iKiFj65iMwI=';

export const T0 = 1_790_000_000_000;

type Json = Record<string, unknown>;

/** JsonDataMessage with every non-NON_NULL field present. */
export function dataMessage(fields: Json): Json {
  return {
    timestamp: T0,
    message: null,
    expiresInSeconds: 0,
    viewOnce: false,
    ...fields,
  };
}

export function groupInfo(type: 'DELIVER' | 'UPDATE' = 'DELIVER'): Json {
  return { groupId: GROUP_ID, groupName: 'Climbing Club', revision: 7, type };
}

function sender(who: 'alice' | 'bob' | 'self'): Json {
  const [uuid, number, name] =
    who === 'alice'
      ? [ALICE, ALICE_NUMBER, 'Alice Liddell']
      : who === 'bob'
        ? [BOB, BOB_NUMBER, 'Bob Ross']
        : [SELF_ACI, SELF_NUMBER, 'Me'];
  return {
    source: number,
    sourceNumber: number,
    sourceUuid: uuid,
    sourceName: name,
    sourceDevice: 1,
  };
}

/** JsonMessageEnvelope wrapped as the SSE payload `{ account, envelope }`. */
export function receive(who: 'alice' | 'bob' | 'self', fields: Json): Json {
  return {
    account: SELF_NUMBER,
    envelope: {
      ...sender(who),
      timestamp: T0,
      serverReceivedTimestamp: T0 + 150,
      serverDeliveredTimestamp: T0 + 300,
      ...fields,
    },
  };
}

const mention = (uuid: string, number: string, start: number, length = 1): Json => ({
  name: number,
  number,
  uuid,
  start,
  length,
});

export const fixtures = {
  dmText: receive('alice', {
    dataMessage: dataMessage({
      message: 'hello there',
      textStyles: [{ style: 'BOLD', start: 6, length: 5 }],
    }),
  }),

  groupMention: receive('alice', {
    dataMessage: dataMessage({
      timestamp: T0 + 2,
      message: 'hey ￼, look at this',
      expiresInSeconds: 3600,
      mentions: [mention(SELF_ACI, SELF_NUMBER, 4)],
      textStyles: [
        { style: 'ITALIC', start: 7, length: 12 },
        { style: 'SPOILER', start: 12, length: 4 },
        { style: 'NONE', start: 0, length: 3 },
        // Out of range: must be clamped away, not crash rendering.
        { style: 'BOLD', start: 400, length: 3 },
      ],
      groupInfo: groupInfo(),
    }),
  }),

  textStyleStrings: receive('alice', {
    dataMessage: dataMessage({
      message: 'mono and strike',
      textStyles: ['0:4:MONOSPACE', '9:6:STRIKETHROUGH'],
    }),
  }),

  quoteReply: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 5,
      message: 'agreed',
      quote: {
        id: T0 - 60_000,
        author: ALICE_NUMBER,
        authorNumber: ALICE_NUMBER,
        authorUuid: ALICE,
        text: 'meet at ￼ at 6?',
        mentions: [mention(SELF_ACI, SELF_NUMBER, 8)],
        attachments: [],
        textStyles: [{ style: 'BOLD', start: 10, length: 4 }],
      },
      groupInfo: groupInfo(),
    }),
  }),

  quoteOfAttachment: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 6,
      message: 'nice pic',
      quote: {
        id: T0 - 1,
        author: SELF_NUMBER,
        authorNumber: SELF_NUMBER,
        authorUuid: SELF_ACI,
        text: null,
        attachments: [{ contentType: 'image/jpeg', filename: null }],
      },
    }),
  }),

  attachments: receive('alice', {
    dataMessage: dataMessage({
      message: '',
      attachments: [
        {
          contentType: 'image/jpeg',
          filename: 'crag.jpg',
          id: 'Zx9aB1cD2eF3.jpg',
          size: 482_113,
          width: 1600,
          height: 1200,
          caption: null,
          uploadTimestamp: T0 - 10,
          isVoiceNote: false,
        },
        {
          contentType: 'application/pdf',
          filename: 'topo.pdf',
          id: 'Qq8rS7tU6vW5.pdf',
          size: 1_024_000,
          width: null,
          height: null,
          caption: null,
          uploadTimestamp: T0 - 10,
          isVoiceNote: false,
        },
      ],
    }),
  }),

  syncSentDm: receive('self', {
    sourceDevice: 2,
    syncMessage: {
      sentMessage: {
        destination: BOB_NUMBER,
        destinationNumber: BOB_NUMBER,
        destinationUuid: BOB,
        timestamp: T0 + 10,
        message: 'sent from my phone',
        expiresInSeconds: 0,
        viewOnce: false,
      },
    },
  }),

  syncSentGroup: receive('self', {
    sourceDevice: 2,
    syncMessage: {
      sentMessage: {
        destination: null,
        destinationNumber: null,
        destinationUuid: null,
        ...dataMessage({ timestamp: T0 + 11, message: 'to the group', groupInfo: groupInfo() }),
      },
    },
  }),

  editIncoming: receive('alice', {
    editMessage: {
      targetSentTimestamp: T0,
      dataMessage: dataMessage({
        timestamp: T0 + 20,
        message: 'hello there (edited)',
        textStyles: [{ style: 'BOLD', start: 6, length: 5 }],
      }),
    },
  }),

  syncSentEdit: receive('self', {
    syncMessage: {
      sentMessage: {
        destination: null,
        destinationNumber: null,
        destinationUuid: null,
        editMessage: {
          targetSentTimestamp: T0 + 11,
          dataMessage: dataMessage({
            timestamp: T0 + 30,
            message: 'to the group!',
            groupInfo: groupInfo(),
          }),
        },
      },
    },
  }),

  reactionAdd: receive('alice', {
    dataMessage: dataMessage({
      timestamp: T0 + 40,
      reaction: {
        emoji: '🎯',
        targetAuthor: SELF_NUMBER,
        targetAuthorNumber: SELF_NUMBER,
        targetAuthorUuid: SELF_ACI,
        targetSentTimestamp: T0 - 5,
        isRemove: false,
      },
      groupInfo: groupInfo(),
    }),
  }),

  reactionRemove: receive('alice', {
    dataMessage: dataMessage({
      timestamp: T0 + 41,
      reaction: {
        emoji: '🎯',
        targetAuthor: SELF_NUMBER,
        // Only the number: must still resolve to our ACI.
        targetAuthorNumber: SELF_NUMBER,
        targetAuthorUuid: null,
        targetSentTimestamp: T0 - 5,
        isRemove: true,
      },
    }),
  }),

  remoteDelete: receive('alice', {
    dataMessage: dataMessage({ timestamp: T0 + 50, remoteDelete: { timestamp: T0 } }),
  }),

  adminDelete: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 51,
      adminDelete: {
        targetAuthor: ALICE_NUMBER,
        targetAuthorNumber: ALICE_NUMBER,
        targetAuthorUuid: ALICE,
        targetSentTimestamp: T0,
      },
      groupInfo: groupInfo(),
    }),
  }),

  pin: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 60,
      pinMessage: {
        targetAuthor: ALICE_NUMBER,
        targetAuthorNumber: ALICE_NUMBER,
        targetAuthorUuid: ALICE,
        targetSentTimestamp: T0,
        pinDurationSeconds: -1,
      },
      groupInfo: groupInfo(),
    }),
  }),

  unpin: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 61,
      unpinMessage: {
        targetAuthor: ALICE_NUMBER,
        targetAuthorNumber: ALICE_NUMBER,
        targetAuthorUuid: ALICE,
        targetSentTimestamp: T0,
      },
      groupInfo: groupInfo(),
    }),
  }),

  expirationDm: receive('alice', {
    dataMessage: dataMessage({
      timestamp: T0 + 70,
      expiresInSeconds: 604_800,
      isExpirationUpdate: true,
    }),
  }),

  expirationOff: receive('self', {
    syncMessage: {
      sentMessage: {
        destination: ALICE_NUMBER,
        destinationNumber: ALICE_NUMBER,
        destinationUuid: ALICE,
        ...dataMessage({ timestamp: T0 + 71, expiresInSeconds: 0, isExpirationUpdate: true }),
      },
    },
  }),

  groupUpdate: receive('bob', {
    dataMessage: dataMessage({ timestamp: T0 + 80, groupInfo: groupInfo('UPDATE') }),
  }),

  groupCall: receive('bob', {
    dataMessage: dataMessage({
      timestamp: T0 + 81,
      groupCallUpdate: { eraId: 'abc123' },
      groupInfo: groupInfo(),
    }),
  }),

  typingStarted: receive('alice', {
    typingMessage: { action: 'STARTED', timestamp: T0 },
  }),

  typingStoppedGroup: receive('bob', {
    typingMessage: { action: 'STOPPED', timestamp: T0, groupId: GROUP_ID },
  }),

  receiptDelivered: receive('alice', {
    receiptMessage: {
      when: T0 + 1,
      isDelivery: true,
      isRead: false,
      isViewed: false,
      timestamps: [T0 - 5, T0 - 4],
    },
  }),

  receiptRead: receive('alice', {
    receiptMessage: {
      when: T0 + 2,
      isDelivery: false,
      isRead: true,
      isViewed: false,
      timestamps: [T0 - 5],
    },
  }),

  receiptViewed: receive('alice', {
    receiptMessage: {
      when: T0 + 3,
      isDelivery: false,
      isRead: false,
      isViewed: true,
      timestamps: [T0 - 5],
    },
  }),

  readSync: receive('self', {
    syncMessage: {
      readMessages: [
        { sender: ALICE_NUMBER, senderNumber: ALICE_NUMBER, senderUuid: ALICE, timestamp: T0 },
        { sender: BOB_NUMBER, senderNumber: BOB_NUMBER, senderUuid: null, timestamp: T0 + 5 },
      ],
    },
  }),

  contactsSync: receive('self', { syncMessage: { type: 'CONTACTS_SYNC' } }),

  sticker: receive('alice', {
    dataMessage: dataMessage({ sticker: { packId: 'a1b2c3d4', stickerId: 3 } }),
  }),

  viewOnce: receive('alice', {
    dataMessage: dataMessage({
      viewOnce: true,
      attachments: [
        {
          contentType: 'image/jpeg',
          filename: null,
          id: 'secret.jpg',
          size: 1000,
          width: 10,
          height: 10,
          caption: null,
          uploadTimestamp: null,
          isVoiceNote: false,
        },
      ],
    }),
  }),

  poll: receive('alice', {
    dataMessage: dataMessage({
      pollCreate: { question: 'Where to?', allowMultiple: false, options: ['Crag', 'Gym'] },
      groupInfo: groupInfo(),
    }),
  }),

  pollVote: receive('bob', {
    dataMessage: dataMessage({
      pollVote: {
        author: ALICE_NUMBER,
        authorNumber: ALICE_NUMBER,
        authorUuid: ALICE,
        targetSentTimestamp: T0,
        optionIndexes: [1],
        voteCount: 1,
      },
      groupInfo: groupInfo(),
    }),
  }),

  profileKeyUpdate: receive('alice', {
    dataMessage: dataMessage({ isProfileKeyUpdate: true, hasProfileKey: true }),
  }),

  call: receive('alice', {
    callMessage: { offerMessage: { id: 1, type: 'AUDIO_CALL', opaque: 'AAAA' } },
  }),

  story: receive('alice', {
    storyMessage: { allowsReplies: true, textAttachment: { text: 'story' } },
  }),

  exceptionOnly: {
    account: SELF_NUMBER,
    exception: { message: 'Untrusted identity', type: 'UntrustedIdentityException' },
  },

  /** A future/broken daemon: bad dataMessage must not crash, just be skipped. */
  malformedData: receive('alice', {
    dataMessage: { timestamp: 'yesterday', message: 42 },
  }),

  /** A bad quote must not take the message down with it. */
  malformedQuote: receive('alice', {
    dataMessage: dataMessage({ message: 'still here', quote: { id: 'nope' } }),
  }),
} satisfies Record<string, unknown>;
