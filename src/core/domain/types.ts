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
}

/** `true` = muted indefinitely; `{ until }` = epoch ms when the mute lapses. */
export type MuteState = boolean | { until: number };

export interface Conversation {
  id: ConversationId;
  kind: ConversationKind;
  title: string;
  description?: string;
  avatarUrl?: string;
  memberIds: string[];
  adminIds: string[];
  muted: MuteState;
  archived: boolean;
  pinned: boolean;
  /** Disappearing-message timer in seconds; 0 = off. */
  expireTimerSec: number;
  lastActivityAt: number;
  draft?: string;
}

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

export interface Quote {
  authorId: string;
  sentAt: number;
  text: string;
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
  /** Sender's timestamp (epoch ms) — half of the Signal message identity. */
  sentAt: number;
  receivedAt: number;
  body: string;
  ranges: BodyRange[];
  quote?: Quote;
  attachments: Attachment[];
  reactions: Reaction[];
  /** Number of times the message has been edited. */
  edits?: number;
  editedAt?: number;
  deleted?: boolean;
  expiresAt?: number;
  status: MessageStatus;
  kind: MessageKind;
  systemText?: string;
  pinned?: boolean;
  /** Client nonce for optimistic messages; cleared once acknowledged. */
  nonce?: string;
}

export type ConnectionStatus = 'connecting' | 'online' | 'offline' | 'error';
