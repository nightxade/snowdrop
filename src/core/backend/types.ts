/**
 * The contract every transport (mock, signal-cli) implements.
 *
 * Adapters translate protocol quirks (envelopes, sync messages, JSON-RPC
 * errors) into these domain-level calls and events. Nothing above this layer
 * knows which transport is active; the UI never sees raw envelopes.
 */
import type {
  Attachment,
  BodyRange,
  ConnectionStatus,
  Contact,
  Conversation,
  ConversationId,
  Message,
  Quote,
  Reaction,
} from '@/core/domain';
import type { Unsubscribe } from '@/core/lib';

export type BackendKind = 'mock' | 'signal-cli';

/** A file picked by the user, before upload. */
export interface OutgoingAttachment {
  fileName: string;
  contentType: string;
  /** Raw bytes (File/Blob in the browser). */
  data: Blob;
}

export interface SendInput {
  conversationId: ConversationId;
  /** Body with mention placeholders (U+FFFC) already in place. */
  body: string;
  /** Style and mention ranges, in UTF-16 code units. */
  ranges: BodyRange[];
  quote?: Quote;
  attachments?: OutgoingAttachment[];
}

export interface EditInput {
  conversationId: ConversationId;
  /** sentAt of the *original* message (Signal edits always target the original). */
  targetSentAt: number;
  body: string;
  ranges: BodyRange[];
}

export interface ReactInput {
  conversationId: ConversationId;
  targetAuthorId: string;
  targetSentAt: number;
  emoji: string;
  remove: boolean;
}

/** Protocol-level changes only; pin/mute/archive are local (see localStore). */
export type ConversationPatch = Partial<
  Pick<Conversation, 'expireTimerSec' | 'title' | 'description'>
>;

export type RecipientFailureReason =
  'unregistered' | 'untrusted-identity' | 'rate-limited' | 'network' | 'unknown';

export interface RecipientFailure {
  recipientId: string;
  reason: RecipientFailureReason;
}

/**
 * Result of a send. Adapters throw when nobody received the message; partial
 * failures in groups are reported per recipient and the message counts as sent.
 */
export interface SendResult {
  sentAt: number;
  attachments?: Attachment[];
  recipientFailures?: RecipientFailure[];
}

/** A message reference as Signal addresses it. */
export interface MessageRef {
  authorId: string;
  sentAt: number;
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
  /** Return messages strictly older than this sentAt; omit for the newest page. */
  before?: number;
  limit: number;
}

export interface HistoryPage {
  /** Ascending by sentAt. */
  messages: Message[];
  hasMoreBefore: boolean;
  /**
   * Backend's knowledge of the last read position (sentAt), when it has one.
   * Only meaningful on the newest page; used to seed read cursors on first sync.
   */
  readUpTo?: number;
}

export type ReceiptType = 'delivered' | 'read' | 'viewed';

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
  };
  reaction: {
    conversationId: ConversationId;
    targetAuthorId: string;
    targetSentAt: number;
    reaction: Reaction;
    remove: boolean;
  };
  /** Receipts for messages *we* sent; `authorId` is the recipient who sent the receipt. */
  receipt: { authorId: string; sentAts: number[]; type: ReceiptType };
  typing: { conversationId: ConversationId; authorId: string; typing: boolean };
  /**
   * We read these messages on another linked device. Signal identifies them
   * only by (author, sentAt); the sync engine resolves the conversation.
   */
  readSync: { messages: MessageRef[] };
  conversationUpdated: Conversation;
  contactUpdated: Contact;
}

export interface LinkFlow {
  /** Begins device linking; `uri` is rendered as a QR code (sgnl://linkdevice?...). */
  start(): Promise<{ uri: string }>;
  /** Resolves once the primary device has scanned the code and linking completed. */
  finish(uri: string, deviceName: string): Promise<{ accountId: string }>;
}

export interface ChatBackend {
  readonly kind: BackendKind;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;

  getSelf(): Promise<Contact>;
  listContacts(): Promise<Contact[]>;
  listConversations(): Promise<Conversation[]>;

  /** Resolves with the timestamp Signal assigned, which becomes the message identity. */
  send(input: SendInput): Promise<SendResult>;
  edit(input: EditInput): Promise<{ sentAt: number }>;
  react(input: ReactInput): Promise<void>;
  deleteForEveryone(conversationId: ConversationId, sentAt: number): Promise<void>;
  /** Group admins deleting someone else's message, when the protocol supports it. */
  adminDelete?(conversationId: ConversationId, target: MessageRef): Promise<void>;
  pinMessage?(input: PinInput): Promise<void>;
  setTyping(conversationId: ConversationId, typing: boolean): Promise<void>;
  markRead(conversationId: ConversationId, messages: MessageRef[]): Promise<void>;
  updateConversation?(conversationId: ConversationId, patch: ConversationPatch): Promise<void>;

  /**
   * Server-side history, when the transport has any. signal-cli keeps no
   * history (we persist everything we see), so only the mock implements this
   * to provide a rich seeded world. Callers must treat it as optional.
   */
  fetchHistory?(conversationId: ConversationId, query: HistoryQuery): Promise<HistoryPage>;

  link?: LinkFlow;

  on<E extends keyof BackendEvents>(event: E, fn: (payload: BackendEvents[E]) => void): Unsubscribe;
}
