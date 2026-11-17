/**
 * The contract every transport (mock, signal-cli) implements.
 *
 * Adapters translate protocol quirks (envelopes, sync messages, JSON-RPC
 * errors) into these domain-level calls and events. Nothing above this layer
 * knows which transport is active; the UI never sees raw envelopes.
 */
import type {
  Attachment,
  AvatarRef,
  BodyRange,
  ConnectionStatus,
  Contact,
  Conversation,
  ConversationId,
  GroupLinkMode,
  GroupPermissions,
  LinkPreview,
  Message,
  MessageId,
  Quote,
  Reaction,
  RecipientQuery,
  StickerContent,
} from '@/core/domain';
import type { Unsubscribe } from '@/core/lib';

/**
 * A transport's registered kind (`'mock'`, `'signal-cli'`, …): an open set.
 * Backends are registered in the composition root (`app/backends.ts`).
 */
export type BackendKind = string;

/** A registered backend as the UI lists it (Settings → Connection). */
export interface BackendOption {
  kind: BackendKind;
  /** Short name: "Demo", "signal-cli". */
  label: string;
  description?: string;
}

/** A file picked by the user, before upload. */
export interface OutgoingAttachment {
  fileName: string;
  contentType: string;
  /** Raw bytes (File/Blob in the browser). */
  data: Blob;
  /**
   * Local, render-only URL of the same bytes (e.g. an object URL from the
   * composer). Shown on the optimistic message until the transport returns
   * its own URL; never sent anywhere.
   */
  previewUrl?: string;
  /** Pixel size, when known (images): reserves the layout before load. */
  width?: number;
  height?: number;
  /**
   * Sent as a voice note (Signal's voice-message flag). The transport applies it to the send as a
   * whole, so a voice note is the message's only attachment.
   */
  voiceNote?: boolean;
}

/**
 * A custom emoji used (as `:name:`) in an outgoing message's body, for
 * backends that can deliver it (see the `customEmojiDelivery` feature).
 */
export interface OutgoingCustomEmoji {
  name: string;
  /** The emoji's stored image: a `data:` URI (core/stores/customEmoji.ts). */
  dataUrl: string;
}

/**
 * A link preview the *composer* fetched for a URL in the draft (desktop
 * only — see `link_preview_fetch`). Sent as-is; `image`, when present, rides
 * the same data-URI path as a regular attachment.
 */
export interface OutgoingLinkPreview {
  url: string;
  title: string;
  description?: string;
  image?: {
    contentType: string;
    data: Blob;
    /** Local, render-only URL of the same bytes, shown until the send is acknowledged. */
    previewUrl?: string;
    width?: number;
    height?: number;
  };
}

/** A poll to create: its question and 2 to 10 options, already tidied (see `pollDraftProblem`). */
export interface OutgoingPoll {
  question: string;
  options: string[];
  allowMultiple: boolean;
}

export interface SendInput {
  conversationId: ConversationId;
  /** Body with mention placeholders (U+FFFC) already in place. */
  body: string;
  /** Style and mention ranges, in UTF-16 code units. */
  ranges: BodyRange[];
  quote?: Quote;
  attachments?: OutgoingAttachment[];
  /** Deduplicated custom emoji used in `body`; only sent when the backend supports it. */
  customEmoji?: OutgoingCustomEmoji[];
  /** At most one, like Signal's own clients; its `url` must appear in `body`. */
  preview?: OutgoingLinkPreview;
  /**
   * A sticker send: the message's whole content (empty `body`, no
   * attachments; a `quote` still applies). Only `packId` and `stickerId` go
   * over the wire; `emoji` and `url` are render-only (the optimistic message
   * and, for the demo, the image itself).
   */
  sticker?: StickerContent;
  /**
   * A poll send: the message's whole content (empty `body`, no attachments,
   * no quote). Only sent in a conversation whose backend can vote
   * (`ChatBackend.votePoll`).
   */
  poll?: OutgoingPoll;
}

/** One sticker of an installed pack, as the picker lists it. */
export interface StickerPackSticker {
  stickerId: number;
  /** The pack author's emoji for it (may be empty). */
  emoji: string;
  /** Already resolved, directly renderable image (the demo backend only). */
  url?: string;
}

/**
 * An installed sticker pack, listed for the picker. Deliberately has no pack
 * key (nor the share URL that embeds it): that never leaves the transport.
 */
export interface StickerPackInfo {
  /** Pack id, hex. */
  packId: string;
  title: string;
  author: string;
  /** Pack cover (or its first sticker) — the picker's tab icon. */
  cover: StickerPackSticker;
  stickers: StickerPackSticker[];
}

/**
 * A sticker pack with its install state, for the pack dialog opened from a
 * received sticker: unlike `StickerPackInfo` (installed packs only), this may
 * be a pack the user has never installed. Still no key and no share URL.
 */
export interface StickerPackDetails extends StickerPackInfo {
  /** Whether the user has installed the pack (it shows in the picker). */
  installed: boolean;
}

export interface EditInput {
  conversationId: ConversationId;
  /** sentAt of the *original* message (Signal edits always target the original). */
  targetSentAt: number;
  body: string;
  ranges: BodyRange[];
  /**
   * The original message's quote. signal-cli builds the edit's whole data
   * message from the call's params, so without it the edit would drop the
   * reply context on recipients' devices. (Attachments can't be re-sent with
   * an edit; Signal clients keep the original's attachments.)
   */
  quote?: Quote;
  /** Deduplicated custom emoji used in `body`; only sent when the backend supports it. */
  customEmoji?: OutgoingCustomEmoji[];
  /**
   * The edited message's link preview. Like the quote, signal-cli rebuilds the
   * whole data message from the call's params and Signal clients replace the
   * original's previews with the edit's, so one left out is dropped for
   * everyone. At most one; its `url` must appear in `body`.
   */
  preview?: OutgoingLinkPreview;
}

/** What an edit sent: when it went out, and its preview as transmitted (for the local copy). */
export interface EditResult {
  sentAt: number;
  preview?: LinkPreview;
}

export interface ReactInput {
  conversationId: ConversationId;
  targetAuthorId: string;
  targetSentAt: number;
  emoji: string;
  remove: boolean;
}

/** One change of our own answer on a poll (`ChatBackend.votePoll`). */
export interface PollVoteInput {
  conversationId: ConversationId;
  pollAuthorId: string;
  /** The poll message's `sentAt`: Signal's id for the poll. */
  pollSentAt: number;
  /** Every option we now choose (empty retracts the vote). */
  optionIndexes: number[];
  /** Signal's per-voter counter: one more than our previous vote's, so receivers keep only the newest. */
  voteCount: number;
}

/** What `respondToMessageRequest` sends. Blocking is `setBlocked`. */
export type MessageRequestResponse = 'accept' | 'delete';

/** Protocol-level changes only; pin/mute/archive are local (see localStore). */
export type ConversationPatch = Partial<
  Pick<Conversation, 'expireTimerSec' | 'title' | 'description'>
>;

/**
 * One edit to a group, as signal-cli's `updateGroup` takes it: any mix of
 * fields, all applied in one call. Member ids are ids from `Conversation`.
 * Adding someone who is asking to join through the group link approves them;
 * removing someone who is invited revokes the invite and someone who is
 * asking to join denies the request.
 */
export interface GroupChange {
  title?: string;
  description?: string;
  /** A new group photo as a `data:` URI (signal-cli can set one but not remove it). */
  avatar?: string;
  addMemberIds?: readonly string[];
  removeMemberIds?: readonly string[];
  addAdminIds?: readonly string[];
  removeAdminIds?: readonly string[];
  link?: GroupLinkMode;
  /** Gives the group link a new password, so the old link stops working. */
  resetLink?: boolean;
  permissions?: Partial<GroupPermissions>;
}

export interface NewGroupInput {
  title: string;
  /** Everyone to start with except us. */
  memberIds: readonly string[];
  /** The group photo as a `data:` URI. */
  avatar?: string;
}

export type RecipientFailureReason =
  'unregistered' | 'untrusted-identity' | 'rate-limited' | 'network' | 'unknown';

export interface RecipientFailure {
  recipientId: string;
  reason: RecipientFailureReason;
}

/**
 * How much the user trusts a person's current key, as Signal Desktop shows it:
 * `verified` (they compared the safety number and marked it), `default` (the
 * key is accepted but not verified), or `untrusted` (a new key the user hasn't
 * approved yet: messages to them are held back until they do).
 */
export type IdentityTrust = 'verified' | 'default' | 'untrusted';

/**
 * A person's safety number with the user. `digits` is 12 groups of 5 digits
 * separated by spaces (the grouping Signal Desktop shows) and `qr` the bytes
 * their phone's scanner reads, or null when the backend can't make one.
 * Sensitive only in that the user is meant to compare it: never log it.
 */
export interface SafetyNumber {
  digits: string;
  qr: readonly number[] | null;
  trust: IdentityTrust;
}

/**
 * Result of a send. Adapters throw when nobody received the message; partial
 * failures in groups are reported per recipient and the message counts as sent.
 */
export interface SendResult {
  sentAt: number;
  attachments?: Attachment[];
  preview?: LinkPreview;
  recipientFailures?: RecipientFailure[];
}

/** A message reference as Signal addresses it. */
export interface MessageRef {
  authorId: string;
  sentAt: number;
}

/** One message removed "for me" on another device: `MessageRef` plus where it was. */
export interface DeletedForMeMessage extends MessageRef {
  conversationId: ConversationId;
}

/**
 * A chat cleared "for me" on another device. The messages the other device
 * still held when it cleared the chat (its newest ones, the way Signal sends
 * them) say how far back to delete: everything up to and including the newest
 * of them that exists here. A chat none of them exists in is left alone.
 */
export interface DeletedForMeConversation {
  conversationId: ConversationId;
  /** The chat's newest messages on that device. */
  mostRecent: MessageRef[];
  /** Its newest messages that don't disappear; used only when none of `mostRecent` exists here. */
  mostRecentNonExpiring: MessageRef[];
  /**
   * The chat itself was deleted (not just a stretch of it cleared): whatever
   * is left, system lines included, goes too, unless a real message remains.
   * Also true for a "local only" delete, which names no messages.
   */
  isFullDelete: boolean;
}

export interface PinInput {
  conversationId: ConversationId;
  targetAuthorId: string;
  targetSentAt: number;
  pin: boolean;
  /** How long the pin lasts; omit for "until unpinned". */
  durationSec?: number;
}

export interface HistoryQuery {
  /** Legacy sender-time boundary for backends without archive cursors. */
  before?: number;
  /** Opaque position of the boundary message, preferred over its sender timestamp. */
  beforeCursor?: string;
  /** Message identity for locating a cached boundary that has no archive cursor yet. */
  beforeId?: MessageId;
  limit: number;
}

export interface HistoryPage {
  /** Oldest to newest in the backend's history order (not necessarily sender time). */
  messages: Message[];
  hasMoreBefore: boolean;
  /**
   * Backend's knowledge of the last read position (sentAt), when it has one.
   * Only meaningful on the newest page; used to seed read cursors on first sync.
   */
  readUpTo?: number;
}

export interface HistoryReadRef {
  id: MessageId;
  cursor: string;
}

export interface HistoryReadState {
  id: MessageId;
  expiresAt?: number;
  unavailable: boolean;
}

export type ReceiptType = 'delivered' | 'read' | 'viewed';

/**
 * The privacy settings the user's phone syncs to a linked device. `null` is
 * "the phone hasn't told this device" (not the same as off).
 */
export interface PhonePrivacySettings {
  readReceipts: boolean | null;
  typingIndicators: boolean | null;
  linkPreviews: boolean | null;
  unidentifiedDeliveryIndicators: boolean | null;
}

/** The settings Snowdrop lets the user change, which are then synced to the phone. */
export type PhonePrivacyPatch = Partial<
  Pick<
    { [K in keyof PhonePrivacySettings]: boolean },
    'readReceipts' | 'typingIndicators' | 'linkPreviews'
  >
>;

/**
 * Your own profile as the editor saves it. Every text field is sent as given
 * (an empty string clears it). `avatar` is a new photo (already cropped and
 * shrunk), `null` removes the photo, and leaving it out keeps the current one.
 */
export interface ProfileUpdate {
  givenName: string;
  familyName: string;
  about: string;
  aboutEmoji: string;
  avatar?: { contentType: string; base64: string } | null;
}

/**
 * The answer to `lookupRecipient`. `found.id` is the peer id the DM will have
 * once messages flow (the same canonical form incoming messages resolve to),
 * so a conversation opened under it never forks from the real one.
 */
export type RecipientLookup =
  | { status: 'found'; id: string; number?: string; username?: string; name?: string }
  | { status: 'not-registered' }
  | { status: 'rate-limited' };

/**
 * Numbers a backend's own catch-ups: `catchingUp` carries the count so far, and
 * `caughtUp` the count when its signal *arrived* (not when it was emitted
 * behind the queue), so a `caughtUp` that belongs to an earlier catch-up is
 * recognisable even when a newer one began before it was delivered.
 */
export interface CatchUpMark {
  seq: number;
}

/** What the phone did with a message request (signal-cli's `messageRequestResponse` types, minus UNKNOWN). */
export type SyncedRequestAnswer =
  'accept' | 'unblockAndAccept' | 'delete' | 'block' | 'blockAndDelete' | 'spam' | 'blockAndSpam';

export interface BackendEvents {
  status: ConnectionStatus;
  /** Incoming message, or one we sent from another linked device (sync). */
  message: Message;
  messageEdited: {
    conversationId: ConversationId;
    authorId: string;
    targetSentAt: number;
    body: string;
    ranges: BodyRange[];
    editedAt: number;
    /** When the server got the edit (epoch ms), when the transport reports it; see `isTooOldToEdit`. */
    serverAt?: number;
    /** The edit's own previews, replacing whatever the original had (possibly none). */
    previews?: LinkPreview[];
  };
  messageDeleted: {
    conversationId: ConversationId;
    authorId: string;
    targetSentAt: number;
    /** Set for admin deletes (the deleter differs from the author). */
    deletedBy?: string;
  };
  messagePinned: {
    conversationId: ConversationId;
    targetAuthorId: string;
    targetSentAt: number;
    pinned: boolean;
    by: string;
    /** When the pin or unpin was sent (epoch ms): the identity of its timeline line. */
    at: number;
  };
  reaction: {
    conversationId: ConversationId;
    targetAuthorId: string;
    targetSentAt: number;
    reaction: Reaction;
    remove: boolean;
    /** When the server got it (epoch ms), when the transport reports it. */
    serverAt?: number;
  };
  /**
   * Someone (or we, from another linked device) changed their answer on a
   * poll. Identified, like every message operation, by the poll's
   * (author, sentAt).
   */
  pollVote: {
    conversationId: ConversationId;
    targetAuthorId: string;
    targetSentAt: number;
    voterId: string;
    optionIndexes: number[];
    voteCount: number;
    /** Sender timestamp of the vote. */
    at: number;
    /** When the server got it (epoch ms), when the transport reports it. */
    serverAt?: number;
  };
  /** The author ended a poll; `authorId` is who sent it (only the poll's author may end it). */
  pollTerminate: {
    conversationId: ConversationId;
    authorId: string;
    targetSentAt: number;
    at: number;
    /** When the server got it (epoch ms), when the transport reports it. */
    serverAt?: number;
  };
  /** Receipts for messages *we* sent; `authorId` is the recipient who sent the receipt. */
  receipt: { authorId: string; sentAts: number[]; type: ReceiptType };
  typing: { conversationId: ConversationId; authorId: string; typing: boolean };
  /**
   * We read these messages on another linked device. Signal identifies them
   * only by (author, sentAt); the sync engine resolves the conversation.
   */
  readSync: {
    messages: MessageRef[];
    /**
     * When they were read on the other device (the sync message's own send
     * time), if the adapter knows: a countdown that started there runs from it.
     */
    readAt?: number;
  };
  /**
   * A message request was answered on the user's phone. Already done there:
   * apply it here without sending anything back. `at` is the answer's own time.
   */
  messageRequestResponse: {
    conversationId: ConversationId;
    /** The same person under their number, when the answer named both and this is a different id. */
    alsoKnownAs?: ConversationId;
    answer: SyncedRequestAnswer;
    at: number;
  };
  /** The user marked a person's safety number verified (or not) on the phone; `at` is when. */
  identityVerified: { contactId: string; verified: boolean; at: number };
  /**
   * Messages were removed "for me" on another of the user's own devices
   * (Signal's `DeleteForMe` sync): already done there, so apply it here and
   * send nothing back. Only emitted where the `deleteSync` feature is present.
   */
  deleteForMe: {
    /** Single messages, each named by author and sent time in its conversation. */
    messages: DeletedForMeMessage[];
    /** Whole chats cleared on that device. */
    conversations: DeletedForMeConversation[];
  };
  conversationUpdated: Conversation;
  contactUpdated: Contact;
  /**
   * The backend finished draining whatever was queued on the server before
   * this connection (or reconnect): CatchUpTracker ends "catching up" and the
   * sidebar stops freezing. Backends with no such notion (or that never send
   * it — upstream signal-cli) simply never emit this; the tracker falls back
   * to a quiet period instead.
   */
  caughtUp: CatchUpMark | undefined;
  /**
   * The backend's connection to the server just (re)started delivering a
   * queue that built up while it was away (signal-cli's own reconnect after
   * a sleep or network change, which Snowdrop's local stream never sees).
   * SyncService starts "catching up" again; the next `caughtUp` ends it.
   * Only emitted where the `catchingUpSignal` feature is present.
   */
  catchingUp: CatchUpMark | undefined;
  /**
   * The phone's privacy settings may have changed (a sync from the phone, or
   * our own `updatePhonePrivacy`); the payload is empty, callers re-read with
   * `readPhonePrivacy`. Only emitted where the `phonePrivacy` feature is present.
   */
  phonePrivacyChanged: undefined;
  /**
   * Every event emitted before this one is complete for transport position
   * `cursor`. The sync engine processes it in queue order — i.e. after the
   * preceding events are persisted — and then calls `backend.acknowledge`.
   * Only transports that can resume (signal-cli's SSE ids) emit it.
   */
  checkpoint: { cursor: string };
  /**
   * Our primary answered a `requestAttachmentBackfill` call (patches/
   * signal-cli, "0014: attachment backfill"). `pending` means the phone is
   * still looking and a later event for the same message may follow;
   * `ready` means whatever it still had was re-uploaded and any of
   * `attachmentIds` may now resolve; `failed` means it doesn't know the
   * message, or its answer didn't otherwise match the request.
   */
  attachmentBackfill: {
    targetAuthorId: string;
    targetSentAt: number;
    status: 'pending' | 'ready' | 'failed';
    attachmentIds: readonly string[];
  };
}

/**
 * Lets a caller give up on a long call (the screen was left, the app is
 * quitting). An aborted call rejects with an error of kind `aborted` and
 * never reports a failure to the user. For a call that changes something
 * (`send`, `link.finish`) an abort after the request left says `maybe-sent`:
 * the other side may still have carried it out.
 */
export interface AbortOptions {
  signal?: AbortSignal;
}

export interface LinkFlow {
  /** Begins device linking; `uri` is rendered as a QR code (sgnl://linkdevice?...). */
  start(options?: AbortOptions): Promise<{ uri: string }>;
  /** Resolves once the primary device has scanned the code and linking completed. */
  finish(
    uri: string,
    deviceName: string,
    options?: AbortOptions,
  ): Promise<{ accountId: string; historyWarning?: string }>;
}

export interface MarkReadOptions {
  /** Tell only the user's own devices; send no receipt to the senders. */
  syncOnly?: boolean;
}

/**
 * What one `markRead` call achieved, as types only (never ids, names or timestamps).
 * `receipt`: `none` (no receipt went out), `success`, or the first failure's reason.
 * `sync`: how telling the user's own devices went: `none` (nothing was sent), `unreported`
 * (the backend can't say, e.g. an older signal-cli), `success`, or the backend's failure type.
 */
export interface ReadSummary {
  receipt: string;
  sync: string;
  /** Set when some recipients' calls failed outright but others went through: the first failure and the counts. */
  failure?: { error: Error; failed: number; of: number };
}

/**
 * What a backend can do beyond the common core. Every `ChatBackend` method
 * exists on every adapter; one that can't do something rejects with
 * `UnsupportedError` (the synchronous peeks and fire-and-forget calls do
 * nothing instead). Whether a call is worth making is read from here, one
 * feature per thing a menu or service decides on. Absent is unsupported.
 *
 * Fixed per adapter (its static `FEATURES`):
 * - `history`: `fetchHistory` serves older messages.
 * - `historyArchive`: an imported phone archive is behind the history
 *   (`getHistoryArchiveId`, `historyHasOutgoing`, `remapHistoryMessages`,
 *   `readHistory`, `getHistoryReadState`).
 * - `pins`: `pinMessage`.
 * - `polls`: `votePoll` and `terminatePoll` (creating one is `send` with
 *   `SendInput.poll`, so this is also what says polls are available).
 * - `adminDelete`: group admins can delete someone else's message.
 * - `conversationSettings`: `updateConversation` (disappearing timer, mute...).
 * - `groups`: `updateGroup`, `createGroup` and `leaveGroup` go together.
 * - `lookup`: `lookupRecipient`.
 * - `messageRequests`: `respondToMessageRequest`.
 * - `blocking`: `setBlocked`.
 * - `safetyNumbers`: `getSafetyNumber`, `verifyIdentity` and `approveIdentity`.
 * - `attachmentUrls`: attachments arrive without a `url`; `resolveAttachmentUrl`
 *   (and the retain/release pair) make them renderable.
 * - `attachmentBlob`: `readAttachmentBlob`.
 * - `avatarUrls`: pictures are fetched on demand (`resolveAvatarUrl`).
 * - `stickers`: `listStickerPacks`, `getStickerPack`, `installStickerPack`.
 * - `stickerUrls`: `resolveStickerUrl` (and the retain/release pair).
 * - `profile`: `updateProfile`.
 * - `phonePrivacyUpdate`: `updatePhonePrivacy` (reading needs `phonePrivacy`).
 * - `contactSync`: `syncContactsAndGroups`.
 * - `deviceLinking`: `link` can link this device.
 *
 * Decided by the running transport (signal-cli's version, known only once
 * connected, and cleared on disconnect):
 * - `readSync`: `markRead` can sync read state to the user's own devices
 *   without sending receipts (patches/signal-cli "0019").
 * - `customEmojiDelivery`: custom emoji images can be sent alongside `:name:`
 *   text (the custom-emoji extension). Gates whether `SendInput.customEmoji`
 *   is worth building at all.
 * - `phonePrivacy`: the phone's synced privacy settings can be read ("0018");
 *   otherwise Snowdrop uses its own local settings.
 * - `catchingUpSignal`: `catchingUp` is emitted ("0020", build 21+), so
 *   `caughtUp` reliably ends every drain; otherwise a quiet period or the
 *   ceiling does.
 * - `orderedCatchingUp`: `catchingUp` is also strictly ordered before every
 *   message of the new connection (build 23+). Implies `catchingUpSignal`.
 * - `stickerPackInstall`: `installStickerPack` can work ("0017"); the dialog
 *   disables Install otherwise.
 * - `attachmentBackfill`: `requestAttachmentBackfill` is answered at all
 *   ("0014"; an older patched build or upstream signal-cli advertises none).
 * - `deleteSync`: `syncDeleteForMe` tells the user's other devices about a
 *   "delete for me", and the `deleteForMe` event reports theirs ("0027",
 *   build 27+).
 */
export type Feature =
  | 'history'
  | 'historyArchive'
  | 'pins'
  | 'polls'
  | 'adminDelete'
  | 'conversationSettings'
  | 'groups'
  | 'lookup'
  | 'messageRequests'
  | 'blocking'
  | 'safetyNumbers'
  | 'attachmentUrls'
  | 'attachmentBlob'
  | 'avatarUrls'
  | 'stickers'
  | 'stickerUrls'
  | 'profile'
  | 'phonePrivacyUpdate'
  | 'contactSync'
  | 'deviceLinking'
  | 'readSync'
  | 'customEmojiDelivery'
  | 'phonePrivacy'
  | 'catchingUpSignal'
  | 'orderedCatchingUp'
  | 'stickerPackInstall'
  | 'attachmentBackfill'
  | 'deleteSync';

/** A changing set of `Feature`s. `features` is a new set on every change, and `subscribe` fires once per change. */
export interface BackendCapabilities {
  readonly features: ReadonlySet<Feature>;
  subscribe(fn: () => void): Unsubscribe;
}

export interface ChatBackend {
  /** What this backend supports beyond the required contract (see `Feature`). */
  readonly capabilities: BackendCapabilities;
  readonly kind: BackendKind;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;

  getSelf(): Promise<Contact>;
  listContacts(): Promise<Contact[]>;
  listConversations(): Promise<Conversation[]>;

  /** Resolves with the timestamp Signal assigned, which becomes the message identity. */
  send(input: SendInput, options?: AbortOptions): Promise<SendResult>;
  edit(input: EditInput): Promise<EditResult>;
  react(input: ReactInput): Promise<void>;
  deleteForEveryone(conversationId: ConversationId, sentAt: number): Promise<void>;
  /** Group admins deleting someone else's message, when the protocol supports it. */
  adminDelete(conversationId: ConversationId, target: MessageRef): Promise<void>;
  pinMessage(input: PinInput): Promise<void>;
  /**
   * Changes our answer on a poll (and tells the other members). Present
   * only on backends that can take part in polls; creating one is `send`
   * with `SendInput.poll`, so this is also what says polls are available.
   */
  votePoll(input: PollVoteInput): Promise<void>;
  /** Ends a poll we created (the poll's `sentAt` identifies it). Same availability as `votePoll`. */
  terminatePoll(conversationId: ConversationId, pollSentAt: number): Promise<void>;
  setTyping(conversationId: ConversationId, typing: boolean): Promise<void>;
  /**
   * Marks messages read: tells their senders (a read receipt) and the user's
   * other devices. With `syncOnly` only the user's own devices are told and
   * nothing goes to the senders; a backend that can't do that
   * (no `readSync` feature) does nothing for a `syncOnly` call. Resolves
   * with what happened where the backend can tell.
   */
  markRead(
    conversationId: ConversationId,
    messages: MessageRef[],
    options?: MarkReadOptions,
  ): Promise<ReadSummary | undefined>;
  updateConversation(conversationId: ConversationId, patch: ConversationPatch): Promise<void>;

  /**
   * Edits a group: its details, members, admins, permissions and link. The
   * group updates (and our own "You added…" line is written) once Signal has
   * accepted the change; a refusal (not an admin, a stale group) rejects with
   * nothing changed. The three group methods below go together: a backend
   * that can edit groups can make and leave them.
   */
  updateGroup(conversationId: ConversationId, change: GroupChange): Promise<void>;
  /** Makes a group, announces it, and resolves with it as it now stands. */
  createGroup(input: NewGroupInput): Promise<Conversation>;
  /**
   * Leaves a group. The last admin must name `newAdminIds`, who are made
   * admins on the way out. The group is deleted from this device too.
   */
  leaveGroup(conversationId: ConversationId, newAdminIds?: readonly string[]): Promise<void>;

  /**
   * Asks the server whether a phone number or username belongs to a Signal
   * user, for starting a chat with someone who isn't a conversation yet.
   * Read-only: nothing is sent to the person, so no profile key is shared
   * until the user's first message. A transport failure rejects; a server
   * rate limit resolves as `rate-limited`.
   */
  lookupRecipient(query: RecipientQuery): Promise<RecipientLookup>;

  /**
   * Answers a message request the way Signal's own clients do, and tells the
   * user's other devices. `accept` shares the user's profile with the
   * sender (or the group) from then on; `delete` withdraws it, and for a
   * group also leaves it. Needs the `messageRequests` feature; without it the
   * app just records the answer locally.
   */
  respondToMessageRequest(
    conversationId: ConversationId,
    response: MessageRequestResponse,
  ): Promise<void>;
  /**
   * The safety number between the user and a person, with how far their key is
   * trusted (Signal Desktop's "View safety number"). Null when there is no key
   * yet (nobody has exchanged messages with them), which can't be verified.
   * Read-only; rejects when the backend can't be reached. The three safety
   * number methods go together.
   */
  getSafetyNumber(contactId: string): Promise<SafetyNumber | null>;
  /**
   * "Mark as verified": trusts the person's key as verified, but only if
   * `digits` (the safety number the user compared) is still the number for the
   * key held. Rejects with `kind: 'user'` when it no longer is (their key
   * changed in between), changing nothing.
   */
  verifyIdentity(contactId: string, digits: string): Promise<void>;
  /**
   * Accepts the person's current key without verifying it, which is both
   * Desktop's "Send anyway" after a safety number change and "Clear
   * verification". Their held-back messages, and ours, can then go through.
   */
  approveIdentity(contactId: string): Promise<void>;
  /** Blocks or unblocks a contact or group (synced to the phone). Needs `blocking`. */
  setBlocked(conversationId: ConversationId, blocked: boolean): Promise<void>;

  /**
   * Asks the primary device to resend contacts, groups and the block list,
   * when the protocol supports it (signal-cli: `sendSyncRequest`). Settings
   * → Connection's "Sync contacts and groups" is the only caller; needs
   * `contactSync`.
   */
  syncContactsAndGroups(): Promise<void>;

  /** The phone's synced privacy settings; rejects if the backend can't tell. */
  readPhonePrivacy(): Promise<PhonePrivacySettings>;
  /**
   * Changes read receipts / typing indicators / link previews the way
   * Signal Desktop does: stored here and synced to the phone. Only the keys
   * in `patch` change.
   */
  updatePhonePrivacy(patch: PhonePrivacyPatch): Promise<void>;
  /**
   * Saves the user's own profile (name, about, photo) the way Signal Desktop
   * does: uploaded to Signal and announced to the linked phone. Resolves to the
   * profile as the backend now holds it; rejects, changing nothing, on failure.
   */
  updateProfile(update: ProfileUpdate): Promise<Contact>;

  /**
   * Backend history, when available (mock seed data or an imported phone
   * archive in patched signal-cli). Needs `history`.
   */
  fetchHistory(
    conversationId: ConversationId,
    query: HistoryQuery,
    options?: AbortOptions,
  ): Promise<HistoryPage>;
  /**
   * Whether the history archive holds a real message the user sent in this
   * conversation (a chat started from their phone). Possibly several heavy
   * lookups, so callers ask only about the few chats that need it and never
   * on a startup path; answers are cached by the adapter.
   */
  historyHasOutgoing(conversationId: ConversationId): Promise<boolean>;
  /**
   * Re-reads already-stored history messages from the archive by their own
   * `historyCursor` and returns the fresh mapping of each one the archive can
   * still supply (matching id, same archive), for the caller to merge into
   * what it has. Rows the archive can't supply — gone, expired, a different
   * archive — are simply absent from the result; never throws for those.
   * Used to bring rows stored by an older mapper up to the current shape.
   */
  remapHistoryMessages(messages: readonly Message[]): Promise<Message[]>;
  /** Persist read-time expiration for viewed imported messages; no network receipts. */
  readHistory(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]>;
  /** Read-only deadline recovery: must not start timers or mark messages read. */
  getHistoryReadState(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]>;

  /**
   * The id of the whole-account archive behind `fetchHistory`, or null if
   * there is none (upstream signal-cli, a link with no "transfer message
   * history", the demo). The one capability check `HistoryImportService`
   * needs to decide whether there's anything to import, and to tell one
   * archive apart from the next (a relink produces a new one, whose cursors
   * supersede the old archive's rather than extending it).
   */
  getHistoryArchiveId(): Promise<string | null>;

  /**
   * Turns an attachment that arrived without a `url` into a renderable one.
   * signal-cli only hands out attachment bytes on request, so its adapter
   * leaves `url` unset and downloads lazily (cached `blob:` URL) when the UI
   * shows the attachment. Needs `attachmentUrls`; adapters whose attachments
   * always carry a `url` (the mock) reject. The returned URL may be
   * revoked after disconnect.
   *
   * Security: the content type is sender-controlled. Adapters only label the
   * bytes with it when it is an allow-listed raster image / audio / video
   * type (never SVG or HTML); anything else is `application/octet-stream`.
   * The UI must use these URLs only as `<img>/<video>/<audio>` sources or
   * `<a download>` targets — never navigate to them or open them in a frame.
   *
   * `forceRefresh` skips any cached URL (and any in-flight request already
   * sharing one) and always re-downloads — for a user-initiated retry, where
   * handing back a cached URL that's already known not to work would make
   * the retry a no-op.
   */
  resolveAttachmentUrl(
    conversationId: ConversationId,
    attachment: Attachment,
    options?: { forceRefresh?: boolean } & AbortOptions,
  ): Promise<string>;

  /**
   * Marks an attachment's resolved URL as in use by a mounted component
   * (an `<img>`/`<video>`/`<audio>` showing it, a lightbox holding it open).
   * Pairs with `releaseAttachmentUrl`. Adapters that cache and evict
   * `resolveAttachmentUrl`'s URLs (signal-cli) use this to keep a byte/entry
   * budget from revoking one still on screen; adapters whose attachments
   * always carry a `url` (the mock) do nothing, since there's nothing of
   * theirs to protect.
   */
  retainAttachmentUrl(attachment: Attachment): void;

  /** Releases a previous `retainAttachmentUrl`. */
  releaseAttachmentUrl(attachment: Attachment): void;

  /**
   * An attachment's bytes (uncached, no URL), for features that must inspect
   * or re-store the file itself — adding a delivered custom emoji to the
   * user's collection — and so can't use `resolveAttachmentUrl`'s `blob:` URL
   * (the app's CSP forbids fetching one). `maxBytes` rejects bigger files.
   */
  readAttachmentBlob(
    conversationId: ConversationId,
    attachment: Attachment,
    options?: { maxBytes?: number } & AbortOptions,
  ): Promise<Blob>;

  /**
   * Turns a sticker into a renderable URL — `resolveAttachmentUrl`'s
   * counterpart, but keyed by `packId`/`stickerId` and fetched through
   * `getSticker` rather than `getAttachment` (the mock, whose stickers
   * always carry their own `url`, doesn't support this; `stickerUrls`). Throws when the sticker's
   * pack isn't (yet) known to the connected signal-cli — the caller decides
   * what to try next (a history archive's own backup copy, then the emoji;
   * see `useStickerUrl`).
   */
  resolveStickerUrl(sticker: StickerContent, options?: { forceRefresh?: boolean }): Promise<string>;

  /**
   * The picture of a person (a contact or the user) or a group, as a URL the
   * UI can put in an `<img>`; `null` when they have none. Fetched lazily, so
   * the UI asks only for avatars that are on screen. The backend caches the
   * answer (concurrent asks share one fetch, and only a few run at once) and
   * forgets it when it learns the picture changed (`Contact.avatarVersion`,
   * `Conversation.avatarVersion`). The picture lives in the daemon's own
   * store; nothing is written anywhere else. Needs `avatarUrls`; backends whose
   * contacts carry their picture (`Contact.avatarUrl`) themselves reject. Rejects
   * when the daemon can't be reached (try again later).
   */
  resolveAvatarUrl(ref: AvatarRef): Promise<string | null>;

  /**
   * What `resolveAvatarUrl` would answer without asking anyone: a URL, `null`
   * for "has none", `undefined` for "not known yet". Lets a row that
   * remounts show its picture on the first frame. `undefined` where
   * `avatarUrls` is absent.
   */
  peekAvatarUrl(ref: AvatarRef): string | null | undefined;
  /**
   * Whether decoded events are still waiting to be emitted (the adapter's own
   * ordered queue). The sync engine's catch-up quiet period never ends while
   * this is true. Always false for an adapter with no such queue.
   */
  hasPendingEvents(): boolean;

  /**
   * The user's *installed* sticker packs with their stickers, for the sticker
   * picker; needs `stickers` (the picker button is hidden without it). Read-only: never installs, uninstalls or syncs a pack,
   * and never exposes a pack key. Packs whose files haven't been fetched yet
   * are fetched here (that is a local download, not an install). Packs that
   * can't be read are left out rather than failing the whole list.
   */
  listStickerPacks(): Promise<StickerPackInfo[]>;

  /**
   * The pack a sticker belongs to, with its stickers and whether it is
   * installed, for the pack dialog. Makes the pack known and downloaded
   * locally if it isn't yet (no install, no sync). Rejects when the pack
   * can't be found or fetched. Never exposes a pack key.
   */
  getStickerPack(sticker: StickerContent): Promise<StickerPackDetails>;

  /**
   * Installs a sticker's pack, the way Signal's own "Install" does — and
   * like it, the install is synced to the user's phone. Only ever called
   * for a user's explicit click; never done implicitly. The pack key is
   * looked up by the transport, not passed in. Rejects on failure.
   */
  installStickerPack(sticker: StickerContent): Promise<void>;

  /** Marks a sticker's resolved URL as in use by a mounted component; pairs with `releaseStickerUrl`. */
  retainStickerUrl(sticker: StickerContent): void;

  /** Releases a previous `retainStickerUrl`. */
  releaseStickerUrl(sticker: StickerContent): void;

  /**
   * Asks our primary device to re-upload a message's attachments, for when
   * the file behind an id is gone (`missing-on-disk`) or its CDN copy
   * expired (`expired`) and nothing local is left to retry from. The actual
   * outcome arrives later as an `attachmentBackfill` event; this call only
   * starts the request (and may resolve before any answer does).
   */
  requestAttachmentBackfill(
    conversationId: ConversationId,
    targetAuthorId: string,
    targetSentAt: number,
    attachmentIds: readonly string[],
  ): Promise<void>;

  /**
   * Tells the user's other devices that these messages of a conversation were
   * deleted "for me" here, so they remove them too (Signal's `DeleteForMe`
   * sync). Nothing goes to anyone else. Needs the `deleteSync` feature, and
   * does nothing without it or with no messages. Resolves once it was handed
   * on, or at once when the user has no other device; rejects if it could not
   * be sent (the local delete stands either way).
   */
  syncDeleteForMe(conversationId: ConversationId, messages: readonly MessageRef[]): Promise<void>;

  /**
   * Marks transport position `cursor` (from a `checkpoint` event) as durably
   * processed, so a restart resumes after it. Losing an acknowledgement only
   * causes re-delivery, which the sync engine deduplicates. Does nothing for
   * an adapter that can't resume.
   */
  acknowledge(cursor: string): void;

  /** Device linking; needs `deviceLinking`, otherwise both steps reject. */
  link: LinkFlow;

  on<E extends keyof BackendEvents>(event: E, fn: (payload: BackendEvents[E]) => void): Unsubscribe;
}
