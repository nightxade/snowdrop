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
  about?: string;
  aboutEmoji?: string;
  /** Stable CSS colour value derived from the id (see colorForId). */
  color: string;
  avatarUrl?: string;
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
  avatarUrl?: string;
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
}

/** Device-local per-conversation state (never sent to Signal). */
export interface LocalConversationState {
  pinned: boolean;
  muted: MuteState;
  archived: boolean;
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
  pinned?: boolean;
  /** Recipients the send failed for (partial group sends); status stays 'sent'. */
  failedRecipients?: string[];
  /** Why a `failed` status happened, when it's more specific than "send failed". */
  failureReason?: string;
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
