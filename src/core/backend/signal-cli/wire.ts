/**
 * Decoders for everything signal-cli sends us, mirroring its Json* records
 * (org.asamk.signal.json.*). Jackson serialises absent values as `null`, so
 * nearly every field is optional; nested parts that can be skipped without
 * losing the message are decoded leniently (`maybe` / `list`).
 *
 * Deprecated legacy fields (`source`, `author`, `targetAuthor`, …) are
 * accepted as fallbacks only: the number/uuid pairs are authoritative.
 */
import {
  bool,
  DecodeError,
  isRecord,
  list,
  maybe,
  num,
  object,
  opt,
  str,
  unknownValue,
  withDefault,
  type Decoder,
  type Infer,
} from './validate';

const optStr = maybe(str);
const optNum = maybe(num);
const optBool = maybe(bool);

// ─── Message parts ───────────────────────────────────────────────────────

export const wireMention = object({
  number: optStr,
  uuid: optStr,
  /** Deprecated legacy identifier; used only when uuid/number are missing. */
  name: optStr,
  start: num,
  length: num,
});
export type WireMention = Infer<typeof wireMention>;

const textStyleObject = object({ style: str, start: num, length: num });
export type WireTextStyle = Infer<typeof textStyleObject>;

/**
 * JsonTextStyle is `{ style: "BOLD", start, length }`; the CLI syntax
 * `"start:length:STYLE"` is accepted too, since some wrappers forward it.
 */
export const wireTextStyle: Decoder<WireTextStyle> = (v, path, issues) => {
  if (typeof v === 'string') {
    const match = /^(\d+):(\d+):([A-Za-z_]+)$/u.exec(v);
    if (!match) throw new DecodeError(path, '"start:length:STYLE"');
    return { start: Number(match[1]), length: Number(match[2]), style: match[3] ?? '' };
  }
  return textStyleObject(v, path, issues);
};

export const wireAttachment = object({
  contentType: withDefault(str, 'application/octet-stream'),
  filename: optStr,
  id: optStr,
  size: optNum,
  width: optNum,
  height: optNum,
  caption: optStr,
  uploadTimestamp: optNum,
  isVoiceNote: optBool,
});
export type WireAttachment = Infer<typeof wireAttachment>;

/**
 * JsonPreview (org.asamk.signal.json.JsonPreview): no `date` field on the
 * wire, unlike the daemon's internal domain model — see
 * docs/SIGNAL_CLI.md-style notes in link-previews-notes.md.
 */
export const wirePreview = object({
  url: str,
  title: optStr,
  description: optStr,
  image: maybe(wireAttachment),
});
export type WirePreview = Infer<typeof wirePreview>;

export const wireQuote = object({
  id: num,
  author: optStr,
  authorNumber: optStr,
  authorUuid: optStr,
  text: optStr,
  mentions: list(wireMention),
  attachments: list(
    object({ contentType: withDefault(str, 'application/octet-stream'), filename: optStr }),
  ),
  textStyles: list(wireTextStyle),
});
export type WireQuote = Infer<typeof wireQuote>;

export const wireReaction = object({
  emoji: str,
  targetAuthor: optStr,
  targetAuthorNumber: optStr,
  targetAuthorUuid: optStr,
  targetSentTimestamp: num,
  isRemove: withDefault(bool, false),
});
export type WireReaction = Infer<typeof wireReaction>;

/** Shared shape of adminDelete / pinMessage / unpinMessage targets. */
const targetFields = {
  targetAuthor: optStr,
  targetAuthorNumber: optStr,
  targetAuthorUuid: optStr,
  targetSentTimestamp: num,
};
export const wireTarget = object(targetFields);
export type WireTarget = Infer<typeof wireTarget>;
export const wirePin = object({ ...targetFields, pinDurationSeconds: optNum });

export const wireGroupInfo = object({
  groupId: str,
  groupName: optStr,
  revision: optNum,
  /** "UPDATE" for group changes, "DELIVER" for ordinary group messages. */
  type: optStr,
});
export type WireGroupInfo = Infer<typeof wireGroupInfo>;

const wireSharedContact = object({
  name: maybe(object({ nickname: optStr, given: optStr, family: optStr })),
  organization: optStr,
});

export const wireDataMessage = object({
  timestamp: num,
  message: optStr,
  expiresInSeconds: optNum,
  isExpirationUpdate: optBool,
  viewOnce: optBool,
  groupCallUpdate: opt(unknownValue),
  isEndSession: optBool,
  isProfileKeyUpdate: optBool,
  reaction: maybe(wireReaction),
  quote: maybe(wireQuote),
  payment: opt(unknownValue),
  mentions: list(wireMention),
  attachments: list(wireAttachment),
  previews: list(wirePreview),
  sticker: maybe(object({ packId: str, stickerId: num })),
  remoteDelete: maybe(object({ timestamp: num })),
  contacts: list(wireSharedContact),
  pollCreate: maybe(object({ question: str, allowMultiple: optBool, options: list(str) })),
  pollVote: opt(unknownValue),
  pollTerminate: opt(unknownValue),
  textStyles: list(wireTextStyle),
  groupInfo: maybe(wireGroupInfo),
  storyContext: opt(unknownValue),
  pinMessage: maybe(wirePin),
  unpinMessage: maybe(wireTarget),
  adminDelete: maybe(wireTarget),
  /** Snowdrop's custom-emoji extension (patches/signal-cli); absent on any other sender/build. */
  customEmoji: list(object({ name: str, attachment: wireAttachment })),
});
export type WireDataMessage = Infer<typeof wireDataMessage>;

export const wireEditMessage = object({
  targetSentTimestamp: num,
  dataMessage: wireDataMessage,
});
export type WireEditMessage = Infer<typeof wireEditMessage>;

// ─── Sync ────────────────────────────────────────────────────────────────

/**
 * JsonSyncDataMessage uses `@JsonUnwrapped` for its data message, so the
 * data fields sit next to the destination. `timestamp` is only present when
 * there *is* a data message (edit-only transcripts have none).
 */
const wireSentTranscript: Decoder<{
  destination: string | undefined;
  destinationNumber: string | undefined;
  destinationUuid: string | undefined;
  editMessage: WireEditMessage | undefined;
  dataMessage: WireDataMessage | undefined;
}> = (v, path, issues) => {
  const base = object({
    destination: optStr,
    destinationNumber: optStr,
    destinationUuid: optStr,
    editMessage: maybe(wireEditMessage),
  })(v, path, issues);
  const hasData = isRecord(v) && v.timestamp !== undefined && v.timestamp !== null;
  return { ...base, dataMessage: hasData ? maybe(wireDataMessage)(v, path, issues) : undefined };
};

export const wireSyncRead = object({
  sender: optStr,
  senderNumber: optStr,
  senderUuid: optStr,
  timestamp: num,
});

export const wireSyncMessage = object({
  sentMessage: maybe(wireSentTranscript),
  sentStoryMessage: opt(unknownValue),
  blockedNumbers: list(str),
  blockedGroupIds: list(str),
  readMessages: list(wireSyncRead),
  /** "CONTACTS_SYNC" | "GROUPS_SYNC" | null */
  type: optStr,
});
export type WireSyncMessage = Infer<typeof wireSyncMessage>;

// ─── Envelope ────────────────────────────────────────────────────────────

export const wireEnvelope = object({
  source: optStr,
  sourceNumber: optStr,
  sourceUuid: optStr,
  sourceName: optStr,
  sourceDevice: optNum,
  timestamp: num,
  serverReceivedTimestamp: optNum,
  dataMessage: maybe(wireDataMessage),
  editMessage: maybe(wireEditMessage),
  storyMessage: opt(unknownValue),
  syncMessage: maybe(wireSyncMessage),
  callMessage: opt(unknownValue),
  receiptMessage: maybe(
    object({
      when: optNum,
      isDelivery: withDefault(bool, false),
      isRead: withDefault(bool, false),
      isViewed: withDefault(bool, false),
      timestamps: list(num),
    }),
  ),
  typingMessage: maybe(object({ action: str, timestamp: optNum, groupId: optStr })),
});
export type WireEnvelope = Infer<typeof wireEnvelope>;

/** One SSE `receive` event: `{ account, envelope?, exception? }`. */
export const wireReceive = object({
  account: optStr,
  envelope: opt(wireEnvelope),
  exception: maybe(object({ message: optStr, type: optStr })),
});
export type WireReceive = Infer<typeof wireReceive>;

// ─── RPC results ─────────────────────────────────────────────────────────

export const wireAccounts = list(object({ number: optStr, aci: optStr }));
export type WireAccount = Infer<typeof wireAccounts>[number];

export const wireContact = object({
  number: optStr,
  uuid: optStr,
  username: optStr,
  name: optStr,
  givenName: optStr,
  familyName: optStr,
  nickName: optStr,
  nickGivenName: optStr,
  nickFamilyName: optStr,
  isBlocked: withDefault(bool, false),
  isHidden: withDefault(bool, false),
  messageExpirationTime: withDefault(num, 0),
  unregistered: withDefault(bool, false),
  /** Signal's "you've chatted, or accepted their message request" flag. */
  profileSharing: withDefault(bool, false),
  profile: maybe(
    object({
      givenName: optStr,
      familyName: optStr,
      about: optStr,
      aboutEmoji: optStr,
      hasAvatar: optBool,
    }),
  ),
});
export type WireContact = Infer<typeof wireContact>;
export const wireContacts = list(wireContact);

const wireMemberAddress = object({ number: optStr, uuid: optStr });
export const wireGroup = object({
  id: str,
  name: optStr,
  description: optStr,
  isMember: withDefault(bool, true),
  isBlocked: withDefault(bool, false),
  messageExpirationTime: withDefault(num, 0),
  members: list(object({ number: optStr, uuid: optStr, isAdmin: optBool })),
  /** Deprecated in favour of members[].isAdmin; kept for older daemons. */
  admins: list(wireMemberAddress),
  isTerminated: optBool,
});
export type WireGroup = Infer<typeof wireGroup>;
export const wireGroups = list(wireGroup);

export const wireSendResultItem = object({
  recipientAddress: maybe(object({ uuid: optStr, number: optStr, username: optStr })),
  groupId: optStr,
  /** SUCCESS | NETWORK_FAILURE | UNREGISTERED_FAILURE | IDENTITY_FAILURE | RATE_LIMIT_FAILURE | INVALID_PRE_KEY_FAILURE */
  type: str,
  retryAfterSeconds: optNum,
});
export type WireSendResultItem = Infer<typeof wireSendResultItem>;

export const wireSendResult = object({
  timestamp: num,
  results: list(wireSendResultItem),
});
export type WireSendResult = Infer<typeof wireSendResult>;

/**
 * `sendReceipt` reply. Lenient on purpose (a receipt has always been fire and forget): `results`
 * may be missing and `sync` is absent on a signal-cli older than patch 0024
 * (`success | network | identity | unregistered | rate-limit | proof-required |
 * skipped-no-aci | skipped-single-device | error`; kept as a string so a newer value still reads).
 */
export const wireReceiptReply = object({
  results: withDefault(list(wireSendResultItem), []),
  sync: optStr,
});
export type WireReceiptReply = Infer<typeof wireReceiptReply>;

/**
 * `listStickerPacks` items (ListStickerPacksCommand.JsonStickerPack). The
 * pack's `url` is deliberately NOT decoded: it embeds the pack key, which
 * must never leave this decoder (it would otherwise reach stores, logs or
 * the UI). A pack whose files haven't been downloaded yet lists with no
 * title, no cover and no stickers.
 */
const wireStickerPackSticker = object({
  id: num,
  emoji: withDefault(str, ''),
});
export const wireStickerPack = object({
  packId: str,
  installed: withDefault(bool, false),
  title: withDefault(str, ''),
  author: withDefault(str, ''),
  cover: maybe(wireStickerPackSticker),
  stickers: list(wireStickerPackSticker),
});
export type WireStickerPack = Infer<typeof wireStickerPack>;
export const wireStickerPacks = list(wireStickerPack);

/** `getUserStatus`: one row per number or username asked about (`uuid` is null when unregistered). */
export const wireUserStatuses = list(
  object({
    recipient: optStr,
    number: optStr,
    username: optStr,
    uuid: optStr,
    isRegistered: withDefault(bool, false),
  }),
);

export const wireStartLink = object({ deviceLinkUri: str });
export const wireFinishLink = object({ number: optStr, aci: optStr, historyTransfer: optStr });
export const wireAttachmentData = object({ data: str });
export const wireVersion = object({ version: optStr });
/** `getConfiguration`: each value is a boolean, or null/absent while the phone hasn't said. */
export const wirePhonePrivacy = object({
  readReceipts: optBool,
  typingIndicators: optBool,
  linkPreviews: optBool,
  unidentifiedDeliveryIndicators: optBool,
});

/** Our identity for an address: ACI when known (stable), else the number. */
export function addressId(
  uuid: string | undefined,
  number: string | undefined,
  legacy?: string,
): string | undefined {
  return uuid ?? number ?? legacy;
}
