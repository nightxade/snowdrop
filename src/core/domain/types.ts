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
  /** Custom emoji the sender delivered with this message (received only; see CustomEmojiDelivery). */
  customEmoji?: CustomEmojiDelivery[];
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
   * Client nonce of an outgoing message. Kept after acknowledgement (in memory
   * and storage) so render keys survive the pending → acknowledged id swap.
   */
  nonce?: string;
}

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';
