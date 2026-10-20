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
  LinkPreview,
  Message,
  MessageId,
  Quote,
  Reaction,
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
}

/**
 * A custom emoji used (as `:name:`) in an outgoing message's body, for
 * backends that can deliver it (see `ChatBackend.supportsCustomEmojiDelivery`).
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
  preview?: LinkPreview;
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
   * The backend finished draining whatever was queued on the server before
   * this connection (or reconnect): CatchUpTracker ends "catching up" and the
   * sidebar stops freezing. Backends with no such notion (or that never send
   * it — upstream signal-cli) simply never emit this; the tracker falls back
   * to a quiet period instead.
   */
  caughtUp: undefined;
  /**
   * Every event emitted before this one is complete for transport position
   * `cursor`. The sync engine processes it in queue order — i.e. after the
   * preceding events are persisted — and then calls `backend.acknowledge`.
   * Only transports that can resume (signal-cli's SSE ids) emit it.
   */
  checkpoint: { cursor: string };
  /**
   * Our primary answered a `requestAttachmentBackfill` call (patches/
   * signal-cli, "0016: attachment backfill"). `pending` means the phone is
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

export interface LinkFlow {
  /** Begins device linking; `uri` is rendered as a QR code (sgnl://linkdevice?...). */
  start(): Promise<{ uri: string }>;
  /** Resolves once the primary device has scanned the code and linking completed. */
  finish(uri: string, deviceName: string): Promise<{ accountId: string; historyWarning?: string }>;
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
   * Asks the primary device to resend contacts, groups and the block list,
   * when the protocol supports it (signal-cli: `sendSyncRequest`). Settings
   * → Connection's "Sync contacts and groups" is the only caller; adapters
   * without an equivalent (the mock) omit it.
   */
  syncContactsAndGroups?(): Promise<void>;

  /**
   * Whether the connected backend can deliver custom emoji images alongside
   * `:name:` text (patches/signal-cli's custom-emoji extension). Gates
   * whether `SendInput.customEmoji` is worth building at all; adapters
   * without this capability (upstream signal-cli, the mock) omit it, which
   * is the same as always returning false.
   */
  supportsCustomEmojiDelivery?(): boolean;

  /**
   * Backend history, when available (mock seed data or an imported phone
   * archive in patched signal-cli). Callers must treat it as optional.
   */
  fetchHistory?(conversationId: ConversationId, query: HistoryQuery): Promise<HistoryPage>;
  /**
   * Re-reads already-stored history messages from the archive by their own
   * `historyCursor` and returns the fresh mapping of each one the archive can
   * still supply (matching id, same archive), for the caller to merge into
   * what it has. Rows the archive can't supply — gone, expired, a different
   * archive — are simply absent from the result; never throws for those.
   * Used to bring rows stored by an older mapper up to the current shape.
   */
  remapHistoryMessages?(messages: readonly Message[]): Promise<Message[]>;
  /** Persist read-time expiration for viewed imported messages; no network receipts. */
  readHistory?(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]>;
  /** Read-only deadline recovery: must not start timers or mark messages read. */
  getHistoryReadState?(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]>;

  /**
   * The id of the whole-account archive behind `fetchHistory`, or null if
   * there is none (upstream signal-cli, a link with no "transfer message
   * history", the demo). The one capability check `HistoryImportService`
   * needs to decide whether there's anything to import, and to tell one
   * archive apart from the next (a relink produces a new one, whose cursors
   * supersede the old archive's rather than extending it).
   */
  getHistoryArchiveId?(): Promise<string | null>;

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
   *
   * `forceRefresh` skips any cached URL (and any in-flight request already
   * sharing one) and always re-downloads — for a user-initiated retry, where
   * handing back a cached URL that's already known not to work would make
   * the retry a no-op.
   */
  resolveAttachmentUrl?(
    conversationId: ConversationId,
    attachment: Attachment,
    options?: { forceRefresh?: boolean },
  ): Promise<string>;

  /**
   * Marks an attachment's resolved URL as in use by a mounted component
   * (an `<img>`/`<video>`/`<audio>` showing it, a lightbox holding it open).
   * Pairs with `releaseAttachmentUrl`. Adapters that cache and evict
   * `resolveAttachmentUrl`'s URLs (signal-cli) use this to keep a byte/entry
   * budget from revoking one still on screen; adapters whose attachments
   * always carry a `url` (the mock) omit both this and `releaseAttachmentUrl`
   * since there's nothing of theirs to protect.
   */
  retainAttachmentUrl?(attachment: Attachment): void;

  /** Releases a previous `retainAttachmentUrl`. */
  releaseAttachmentUrl?(attachment: Attachment): void;

  /**
   * An attachment's bytes (uncached, no URL), for features that must inspect
   * or re-store the file itself — adding a delivered custom emoji to the
   * user's collection — and so can't use `resolveAttachmentUrl`'s `blob:` URL
   * (the app's CSP forbids fetching one). `maxBytes` rejects bigger files.
   */
  readAttachmentBlob?(
    conversationId: ConversationId,
    attachment: Attachment,
    options?: { maxBytes?: number },
  ): Promise<Blob>;

  /**
   * Turns a sticker into a renderable URL — `resolveAttachmentUrl`'s
   * counterpart, but keyed by `packId`/`stickerId` and fetched through
   * `getSticker` rather than `getAttachment` (the mock, whose stickers
   * always carry their own `url`, omits this). Throws when the sticker's
   * pack isn't (yet) known to the connected signal-cli — the caller decides
   * what to try next (a history archive's own backup copy, then the emoji;
   * see `useStickerUrl`).
   */
  resolveStickerUrl?(
    sticker: StickerContent,
    options?: { forceRefresh?: boolean },
  ): Promise<string>;

  /**
   * The user's *installed* sticker packs with their stickers, for the sticker
   * picker; omitted by backends that can't send stickers (the picker button
   * is hidden then). Read-only: never installs, uninstalls or syncs a pack,
   * and never exposes a pack key. Packs whose files haven't been fetched yet
   * are fetched here (that is a local download, not an install). Packs that
   * can't be read are left out rather than failing the whole list.
   */
  listStickerPacks?(): Promise<StickerPackInfo[]>;

  /**
   * The pack a sticker belongs to, with its stickers and whether it is
   * installed, for the pack dialog. Makes the pack known and downloaded
   * locally if it isn't yet (no install, no sync). Rejects when the pack
   * can't be found or fetched. Never exposes a pack key.
   */
  getStickerPack?(sticker: StickerContent): Promise<StickerPackDetails>;

  /**
   * Whether `installStickerPack` can work against the connected backend
   * (patches/signal-cli's "0021"); the dialog disables Install otherwise.
   * Omitted is the same as false.
   */
  supportsStickerPackInstall?(): boolean;

  /**
   * Installs a sticker's pack, the way Signal's own "Install" does — and
   * like it, the install is synced to the user's phone. Only ever called
   * for a user's explicit click; never done implicitly. The pack key is
   * looked up by the transport, not passed in. Rejects on failure.
   */
  installStickerPack?(sticker: StickerContent): Promise<void>;

  /** Marks a sticker's resolved URL as in use by a mounted component; pairs with `releaseStickerUrl`. */
  retainStickerUrl?(sticker: StickerContent): void;

  /** Releases a previous `retainStickerUrl`. */
  releaseStickerUrl?(sticker: StickerContent): void;

  /**
   * Whether the connected backend can answer `requestAttachmentBackfill` at
   * all (patches/signal-cli's "0016: attachment backfill" — an older
   * patched build, or upstream signal-cli, advertises none of this).
   * Adapters without the capability (the mock always supports it; a future
   * adapter without an equivalent would omit both this and the method
   * below) omit this, which is the same as always returning false.
   */
  supportsAttachmentBackfill?(): boolean;

  /**
   * Asks our primary device to re-upload a message's attachments, for when
   * the file behind an id is gone (`missing-on-disk`) or its CDN copy
   * expired (`expired`) and nothing local is left to retry from. The actual
   * outcome arrives later as an `attachmentBackfill` event; this call only
   * starts the request (and may resolve before any answer does).
   */
  requestAttachmentBackfill?(
    conversationId: ConversationId,
    targetAuthorId: string,
    targetSentAt: number,
    attachmentIds: readonly string[],
  ): Promise<void>;

  /**
   * Marks transport position `cursor` (from a `checkpoint` event) as durably
   * processed, so a restart resumes after it. Losing an acknowledgement only
   * causes re-delivery, which the sync engine deduplicates.
   */
  acknowledge?(cursor: string): void;

  link?: LinkFlow;

  on<E extends keyof BackendEvents>(event: E, fn: (payload: BackendEvents[E]) => void): Unsubscribe;
}
