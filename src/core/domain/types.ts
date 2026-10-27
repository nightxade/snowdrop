/**
 * The protocol-neutral domain model. Backend adapters translate their wire
 * formats into these shapes; nothing above core/backend ever sees an envelope.
 */
import type { ConversationId, ConversationKind, MessageId } from './ids';

export interface Contact {
  /** ACI (UUID) when known, otherwise E.164 number. */
  id: string;
  number?: string;
  /** Best display name: nickname/contact name, else profile name, else number. */
  name: string;
  profileName?: string;
  /** The two halves of the profile name, as the person set them (the editor needs them apart). */
  profileGivenName?: string;
  profileFamilyName?: string;
  about?: string;
  aboutEmoji?: string;
  /** Stable CSS colour value derived from the id (see colorForId). */
  color: string;
  /**
   * A picture the app already holds for this person (the session's just-set
   * profile photo, the demo's). Anything the backend stores is fetched by
   * reference instead (`ChatBackend.resolveAvatarUrl`).
   */
  avatarUrl?: string;
  /** The person has a profile photo (signal-cli's `profile.hasAvatar`). */
  hasAvatar?: true;
  /**
   * Changes whenever the backend learns the photo may have changed (the
   * profile's last-update time; bumped by the user's own edit). A shown
   * avatar fetches again when it differs.
   */
  avatarVersion?: number;
  isSelf?: boolean;
  blocked?: boolean;
  /** signal-cli: contact is hidden on the primary device (user removed it from their list). */
  hidden?: boolean;
  /** signal-cli: contact is no longer a registered Signal user. */
  unregistered?: boolean;
  /**
   * Signal's "you've chatted, or accepted their message request" flag.
   * Lets a contact we haven't messaged *from this device* still be listed
   * as a direct conversation (see SignalCliBackend.listConversations).
   */
  profileSharing?: boolean;
  /**
   * The contact is saved on the user's phone (it has a name the user, or their
   * address book, gave it — not just the name the person chose for their own
   * profile). With `profileSharing`, one of the two ways a first message from
   * someone counts as coming from a known contact, not a message request (see
   * core/domain/messageRequests).
   */
  inContacts?: boolean;
}

/** `true` = muted indefinitely; `{ until }` = epoch ms when the mute lapses. */
export type MuteState = boolean | { until: number };

/**
 * Protocol state of a conversation, as the backend reports it. Local-only
 * organisation (pinned, muted, archived, draft) lives in the persisted
 * `localStore` and is combined into a `ConversationView` by selectors, so a
 * backend update can never clobber it.
 */
export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  title: string;
  description?: string;
  /** A photo the app already holds (just set in this session); see `Contact.avatarUrl`. */
  avatarUrl?: string;
  /** Changes when the group's photo may have changed; see `Contact.avatarVersion`. */
  avatarVersion?: number;
  memberIds: string[];
  adminIds: string[];
  /** Disappearing-message timer in seconds; 0 = off. */
  expireTimerSec: number;
  lastActivityAt: number;
  /**
   * The phone's archived state for this conversation (signal-cli: a history
   * chat frame's `archived`, see `history/directory.ts`; the mock sets it
   * directly). A one-time seed hint only, never itself persisted or
   * compared against: `SyncService.initialSync` uses it to set localStore's
   * own `archived` flag for a conversation that has no local state of its
   * own yet, and never touches it again afterwards (see core/stores/local.ts).
   */
  historyArchived?: boolean;
  /**
   * The backend's history archive has at least one real message for this
   * conversation, whether or not any is stored locally yet. SyncService
   * never drops such a direct conversation as stale (see dropStaleDirects).
   */
  historyHasMessages?: boolean;
  /**
   * The user blocked this group (signal-cli: a group's `isBlocked`). A blocked
   * direct conversation is `Contact.blocked` on its peer instead; both read
   * through `isConversationBlocked`.
   */
  blocked?: boolean;
  // The rest of what a group's details carry. Absent for direct conversations
  // and for backends that don't report them (a missing field is "unknown", not
  // "nobody"). Ids are in the same form as `memberIds`.

  /**
   * We left this group (or were taken out of it) but keep its chat and history,
   * read-only, as Signal Desktop does. `memberIds` no longer lists us.
   */
  left?: true;
  /** Invited and not yet joined (signal-cli `pendingMembers`). */
  pendingMemberIds?: string[];
  /** Asked to join through the group link and waiting for an admin (`requestingMembers`). */
  requestingMemberIds?: string[];
  /** Barred from joining again (`banned`). */
  bannedIds?: string[];
  /** Who may add members, edit the details and send messages. */
  permissions?: GroupPermissions;
  /** The group's `https://signal.group/…` link; present only while the link is on. */
  inviteLink?: string;
  /** Members' labels (emoji and/or text), keyed by member id; only members that have one. */
  memberLabels?: Record<string, GroupMemberLabel>;
}

/** Who a group setting is open to. */
export type GroupPermission = 'every-member' | 'only-admins';

export interface GroupPermissions {
  addMember: GroupPermission;
  editDetails: GroupPermission;
  /** `only-admins` is an announcement group: only admins can send. */
  sendMessages: GroupPermission;
}

export interface GroupMemberLabel {
  emoji?: string;
  label?: string;
}

/** The group link as a setting: off, on (anyone with it joins), or on with admin approval. */
export type GroupLinkMode = 'off' | 'on' | 'approval';

/** Device-local per-conversation state (never sent to Signal). */
export interface LocalConversationState {
  pinned: boolean;
  muted: MuteState;
  archived: boolean;
  /**
   * Flagged unread by the user, whatever the real unread count (Signal's "mark
   * as unread"). Absent means not marked. Device-local: nothing is sent.
   */
  markedUnread?: boolean;
  draft?: string;
}

/** What the UI renders: protocol state + local state. */
export type ConversationView = Conversation & LocalConversationState;

/** Mirrors Signal's native body-range styles so formatting survives the round trip. */
export type TextStyle = 'bold' | 'italic' | 'strikethrough' | 'monospace' | 'spoiler';

export const TEXT_STYLES: readonly TextStyle[] = [
  'bold',
  'italic',
  'strikethrough',
  'monospace',
  'spoiler',
];

/**
 * A styled or mention span of a message body. `start`/`length` are in UTF-16
 * code units — the unit Signal uses on the wire and conveniently the native
 * string index unit in JavaScript. Exactly one of `style` / `mentionId` is set.
 */
export interface BodyRange {
  start: number;
  length: number;
  style?: TextStyle;
  mentionId?: string;
}

/**
 * Most body ranges (styles + mentions) kept per message; the rest are dropped.
 * A real message has a handful (Signal's composer yields a few dozen at the
 * very most, since the body is capped at a few thousand characters), so 500 is
 * far beyond legitimate use while keeping render and storage cost bounded
 * against a hostile sender.
 */
export const MAX_BODY_RANGES = 500;

/** Signal replaces a mention's text with this placeholder in the body. */
export const MENTION_PLACEHOLDER = '￼';

export interface Reaction {
  emoji: string;
  authorId: string;
  at: number;
}

export interface Attachment {
  id: string;
  contentType: string;
  fileName?: string;
  size?: number;
  width?: number;
  height?: number;
  /** Resolved, directly renderable URL (blob:, data: or http:). */
  url?: string;
  blurhash?: string;
  /** The sender marked this as a voice note (Signal's `VOICE_MESSAGE` flag); see `isVoiceNote`. */
  voiceNote?: boolean;
}

/**
 * A custom emoji the sender delivered alongside this specific message (a
 * patched signal-cli extension; see docs/SIGNAL_CLI.md "Custom emoji").
 * `name` is the `:name:` token used in `body`; `attachment` is its image,
 * downloadable through the normal attachment path (useAttachmentUrl).
 * Never carries the viewer's own collection for someone else's message —
 * only emoji this exact message actually delivered.
 */
export interface CustomEmojiDelivery {
  name: string;
  attachment: Attachment;
}

/**
 * A sender-generated preview of a link in the message body (Signal's
 * `DataMessage.preview`). The sender's client fetched `url` and attached
 * what it found; recipients only ever render this — they never contact
 * `url` themselves. `image`, when present, is a normal `Attachment` and
 * resolves through the same attachment path as everything else.
 */
export interface LinkPreview {
  url: string;
  title?: string;
  description?: string;
  image?: Attachment;
}

/**
 * A Signal sticker (`DataMessage.sticker` live, or the backup's
 * `StickerMessage`). Its own thing on `Message` — never a fake `Attachment`
 * and never a text note — so it can render the way Signal/Discord-style
 * clients do: the image alone, no bubble (see StickerBubble).
 *
 * Deliberately has no pack decryption key: that stays entirely inside
 * signal-cli (see patches/signal-cli's "0019"), never crossing into this
 * persisted domain model. `packId`/`stickerId` are plain identifiers, not
 * secrets.
 */
export interface StickerContent {
  /** Sticker pack id, hex. */
  packId: string;
  stickerId: number;
  /** The sender's own label for it, when the source carries one (history only). */
  emoji?: string;
  /** Already resolved, directly renderable URL (the mock backend). */
  url?: string;
  /**
   * A history archive's own backup copy of the sticker image (an ordinary
   * `Attachment`), tried when the pack itself can't be fetched — e.g. an
   * archive whose pack this device never received live, and whose
   * transit pointer has since expired too.
   */
  backupAttachment?: Attachment;
}

/**
 * One voter's current answer on a poll. Signal numbers a voter's votes
 * (`voteCount`, +1 each time they change their answer) so that late or
 * reordered deliveries can't resurrect an older answer: the highest count
 * wins. An empty `optionIndexes` is a retracted vote.
 */
export interface PollVote {
  voterId: string;
  /** Indexes into `PollContent.options`: unique, in range; at most one for a single-choice poll. */
  optionIndexes: number[];
  voteCount: number;
  /** Sender timestamp of the vote; only the tie-break between equal counts. */
  at: number;
}

/**
 * A Signal poll (`DataMessage.pollCreate`, or the backup's `Poll`). Its own
 * thing on `Message`, like a sticker: the question and options are not
 * `body` text, and the votes arrive as separate envelopes that change this
 * message in place (see `applyPollVote`).
 */
export interface PollContent {
  question: string;
  options: string[];
  allowMultiple: boolean;
  /** The author ended it: no more votes, final results. */
  ended?: boolean;
  /** One entry per voter (the latest wins), in the order first seen. */
  votes: PollVote[];
}

export interface Quote {
  authorId: string;
  sentAt: number;
  text: string;
  /** Styles and mentions of the quoted text (UTF-16 offsets into `text`). */
  ranges?: BodyRange[];
  /**
   * Attachments of the quoted message (type + name only). Lets a reply to an
   * attachment-only message say what it quotes, natively on every client.
   */
  attachments?: QuotedAttachment[];
  /**
   * Set when quoting a sticker message, purely for Snowdrop's own quote
   * preview (QuoteHeader/ReplyBar) — the wire's quote format has no
   * equivalent of its own, so this never round-trips through signal-cli.
   * `attachments` above carries the cross-client fallback (a generic
   * "Photo"-shaped quote) other clients show instead.
   */
  sticker?: { emoji?: string };
}

export interface QuotedAttachment {
  contentType: string;
  fileName?: string;
}

/**
 * Delivery status of an outgoing message. Incoming messages are always 'read'
 * from the sender's perspective and the field is ignored for them.
 */
export type MessageStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export type MessageKind = 'normal' | 'system';

/**
 * The button a system line carries. A safety-number line ("Safety Number with
 * X has changed") opens that person's safety number; `contactId` is the person
 * (ACI when known, else number, as in `Contact.id`).
 */
export interface SystemAction {
  kind: 'safety-number';
  contactId: string;
}

/**
 * A recipient's furthest-reached receipt for one of our outgoing messages
 * (Message details / "Read by, Delivered to"). Never regresses, same rule as
 * `status` (see `advanceStatus`/`applyRecipientReceipt`); absent for a
 * recipient we haven't heard a receipt from yet (they're implicitly "sent
 * to"). `at` is when *this device* learned of the receipt — Signal's receipt
 * messages don't carry the recipient's own read time, only ours.
 */
export interface RecipientReceipt {
  status: 'delivered' | 'read';
  at: number;
}

export interface Message {
  id: MessageId;
  conversationId: ConversationId;
  authorId: string;
  /**
   * Sender's timestamp (epoch ms) — half of the Signal message identity.
   * Identity only: senders' clocks can be skewed, so never order by it.
   */
  sentAt: number;
  /** When this device received (or sent) it. */
  receivedAt: number;
  /**
   * Local, monotonically increasing arrival sequence assigned by the
   * repository. The timeline and unread state are ordered by this, so a
   * sender with a wrong clock can't bury a new message in the past.
   * Absent only on messages that have not been stored yet.
   */
  seq?: number;
  body: string;
  ranges: BodyRange[];
  quote?: Quote;
  attachments: Attachment[];
  /**
   * Link previews the sender's client generated for a URL in `body` (at most
   * one, like Signal's own clients). Only shown when `url` still appears in
   * `body` — see LinkPreviewCard.
   */
  previews?: LinkPreview[];
  /** Custom emoji the sender delivered with this message (received only; see CustomEmojiDelivery). */
  customEmoji?: CustomEmojiDelivery[];
  /** A sticker, when this message's whole content is one (see StickerContent). */
  sticker?: StickerContent;
  /** A poll, when this message is one (see PollContent). */
  poll?: PollContent;
  reactions: Reaction[];
  /** Number of times the message has been edited. */
  edits?: number;
  editedAt?: number;
  deleted?: boolean;
  /** Who deleted it, when it was an admin delete rather than the author. */
  deletedBy?: string;
  /** Epoch ms after which the message is purged (disappearing messages). */
  expiresAt?: number;
  /** Duration of an imported timer that has not started; cleared after viewing. */
  expiresAfterReadMs?: number;
  /** Opaque backend history position; persisted so paging survives restarts and clock skew. */
  historyCursor?: string;
  status: MessageStatus;
  kind: MessageKind;
  systemText?: string;
  /** A system line's button, if it has one (see `SystemAction`). */
  systemAction?: SystemAction;
  pinned?: boolean;
  /** Recipients the send failed for (partial group sends); status stays 'sent'. */
  failedRecipients?: string[];
  /** Why a `failed` status happened, when it's more specific than "send failed". */
  failureReason?: string;
  /**
   * People whose safety number changed and stopped this send (the message is
   * `failed`): the review dialog lists them. Cleared when the send is retried.
   */
  blockedByIdentity?: string[];
  /**
   * Per-recipient delivery/read state of an outgoing message (groups and
   * DMs alike), keyed by recipient id. Only ever set on messages we sent;
   * `status` stays the single row-level summary (the *highest* status any
   * recipient reached, same as Signal Desktop) — this is the detail behind
   * it, shown in the "Message details" view.
   */
  receipts?: Record<string, RecipientReceipt>;
  /**
   * Client nonce of an outgoing message. Kept after acknowledgement (in memory
   * and storage) so render keys survive the pending → acknowledged id swap.
   */
  nonce?: string;
}

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';
