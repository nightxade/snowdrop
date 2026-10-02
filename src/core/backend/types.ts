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
  /**
   * Local, render-only URL of the same bytes (e.g. an object URL from the
   * composer). Shown on the optimistic message until the transport returns
   * its own URL; never sent anywhere.
   */
  previewUrl?: string;
  /** Pixel size, when known (images): reserves the layout before load. */
  width?: number;
  height?: number;
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
  /**
   * The original message's quote. signal-cli builds the edit's whole data
   * message from the call's params, so without it the edit would drop the
   * reply context on recipients' devices. (Attachments can't be re-sent with
   * an edit; Signal clients keep the original's attachments.)
   */
  quote?: Quote;
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
  /**
   * Every event emitted before this one is complete for transport position
   * `cursor`. The sync engine processes it in queue order — i.e. after the
   * preceding events are persisted — and then calls `backend.acknowledge`.
   * Only transports that can resume (signal-cli's SSE ids) emit it.
   */
  checkpoint: { cursor: string };
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

  /**
   * Turns an attachment that arrived without a `url` into a renderable one.
   * signal-cli only hands out attachment bytes on request, so its adapter
   * leaves `url` unset and downloads lazily (cached `blob:` URL) when the UI
   * shows the attachment. Adapters whose attachments always carry a `url`
   * (the mock) omit this. The returned URL may be revoked after disconnect.
   *
   * Security: the content type is sender-controlled. Adapters only label the
   * bytes with it when it is an allow-listed raster image / audio / video
   * type (never SVG or HTML); anything else is `application/octet-stream`.
   * The UI must use these URLs only as `<img>/<video>/<audio>` sources or
   * `<a download>` targets — never navigate to them or open them in a frame.
   */
  resolveAttachmentUrl?(conversationId: ConversationId, attachment: Attachment): Promise<string>;

  /**
   * Marks transport position `cursor` (from a `checkpoint` event) as durably
   * processed, so a restart resumes after it. Losing an acknowledgement only
   * causes re-delivery, which the sync engine deduplicates.
   */
  acknowledge?(cursor: string): void;

  link?: LinkFlow;

  on<E extends keyof BackendEvents>(event: E, fn: (payload: BackendEvents[E]) => void): Unsubscribe;
}
