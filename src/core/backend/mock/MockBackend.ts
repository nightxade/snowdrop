/**
 * In-memory ChatBackend over a seeded demo world.
 *
 * Behaves like a well-mannered remote: calls are async (optionally with
 * latency), identities follow Signal's (author, sentAt) rule, own sends get
 * delivery/read receipts, and — when liveliness is on — people type, reply
 * and react. All timing goes through the injected clock/scheduler.
 */
import {
  applyDelete,
  applyEdit,
  applyReaction,
  colorForId,
  directConversationId,
  formatDuration,
  messageId,
  parseConversationId,
  type Attachment,
  type ConnectionStatus,
  type Contact,
  type Conversation,
  type ConversationId,
  type LinkPreview,
  type Message,
  type RecipientQuery,
  type StickerContent,
} from '@/core/domain';
import {
  Emitter,
  systemClock,
  systemScheduler,
  type Clock,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import type {
  BackendEvents,
  ChatBackend,
  ConversationPatch,
  EditInput,
  HistoryPage,
  HistoryQuery,
  MarkReadOptions,
  ReadSummary,
  MessageRef,
  MessageRequestResponse,
  PinInput,
  ReactInput,
  RecipientLookup,
  SendResult,
  SendInput,
  StickerPackDetails,
  StickerPackInfo,
} from '../types';
import { MOCK_STICKER_PACKS, type MockStickerPack } from './content/stickers';
import { generateStickerUrl } from './images';
import { Liveliness, type LivelinessOptions } from './liveliness';
import { Random } from './prng';
import { buildWorld, type MockWorld } from './world';

export interface MockBackendOptions {
  seed?: number;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Simulated round-trip latency in ms (0 = resolve on the next microtask). */
  latencyMs?: number;
  liveliness?: LivelinessOptions;
  /** Pre-built world (tests); otherwise built from seed + clock. */
  world?: MockWorld;
  /**
   * Scroll-performance harness only (`?mockBulkMessages=` in the browser):
   * prepends this many synthetic older messages to one conversation's
   * history, so paging has thousands of pages to work through. Ignored when
   * `world` is given. See `scratch/wk/` for the scenario that uses it.
   */
  bulkMessages?: number;
}

export class MockBackendError extends Error {
  override name = 'MockBackendError';
}

export class MockBackend implements ChatBackend {
  readonly kind = 'mock' as const;
  readonly world: MockWorld;
  readonly liveliness: Liveliness;

  private status: ConnectionStatus = 'offline';
  private readonly emitter = new Emitter<BackendEvents>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly latencyMs: number;
  private readonly rnd: Random;
  private lastSentAt = 0;
  private failures: Error[] = [];
  readonly typingSent: { conversationId: ConversationId; typing: boolean }[] = [];
  /** What `markRead` resolves with (tests set it to simulate a failed receipt or sync). */
  readSummary: ReadSummary | undefined = undefined;
  /** Every `markRead` call, for tests asserting what was (not) sent. */
  readonly readReceiptsSent: {
    conversationId: ConversationId;
    messages: MessageRef[];
    syncOnly?: true;
  }[] = [];
  /** Whether this mock can sync reads without receipts (a test turns it off to act like an old signal-cli). */
  readSyncSupported = true;
  /** Whether this mock claims to send `catchingUp` (a test turns it on to act like a patched signal-cli). */
  catchingUpSignalSupported = false;
  /** Every message-request answer, for the same reason. */
  readonly requestResponses: {
    conversationId: ConversationId;
    response: MessageRequestResponse | 'block' | 'unblock';
  }[] = [];

  constructor(options: MockBackendOptions = {}) {
    const seed = options.seed ?? 42;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.latencyMs = options.latencyMs ?? 0;
    this.rnd = new Random(seed ^ 0x5eed);
    this.world =
      options.world ??
      buildWorld({
        seed,
        now: this.clock.now(),
        ...(options.bulkMessages ? { bulk: { count: options.bulkMessages } } : {}),
      });
    this.liveliness = new Liveliness(
      {
        world: this.world,
        clock: this.clock,
        scheduler: this.scheduler,
        rnd: this.rnd,
        emit: (event, payload) => {
          this.emitter.emit(event, payload);
        },
        deliver: (message) => {
          this.deliver(message);
        },
      },
      options.liveliness,
    );
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.setStatus('connecting');
    await this.delay();
    this.setStatus('online');
    // The demo backend has no stale server queue to drain, so it's caught up
    // the moment it connects.
    this.emitter.emit('caughtUp', undefined);
  }

  async disconnect(): Promise<void> {
    this.liveliness.stop();
    await Promise.resolve();
    this.setStatus('offline');
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  on<E extends keyof BackendEvents>(
    event: E,
    fn: (payload: BackendEvents[E]) => void,
  ): Unsubscribe {
    return this.emitter.on(event, fn);
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  async getSelf(): Promise<Contact> {
    await this.delay();
    return structuredClone(this.world.self);
  }

  async listContacts(): Promise<Contact[]> {
    await this.delay();
    return [...this.world.contacts.values()]
      .filter((c) => !c.isSelf)
      .map((c) => structuredClone(c));
  }

  async listConversations(): Promise<Conversation[]> {
    await this.delay();
    return [...this.world.conversations.values()].map((c) => structuredClone(c));
  }

  async fetchHistory(conversationId: ConversationId, query: HistoryQuery): Promise<HistoryPage> {
    await this.delay();
    const history = this.world.histories.get(conversationId) ?? [];
    const before = query.before;
    const end =
      before === undefined ? history.length : history.findIndex((m) => m.sentAt >= before);
    const stop = end === -1 ? history.length : end;
    const start = Math.max(0, stop - query.limit);
    const page: HistoryPage = {
      messages: history.slice(start, stop).map((m) => structuredClone(m)),
      hasMoreBefore: start > 0,
    };
    const readUpTo = this.world.readUpTo.get(conversationId);
    if (query.before === undefined && readUpTo !== undefined) page.readUpTo = readUpTo;
    return page;
  }

  /** Makes `lookupRecipient` answer `rate-limited` (the server's contact-discovery limit). */
  lookupRateLimited = false;

  /**
   * The demo's directory: the people in it (by number), the fictional
   * 202-555-0190…0199 numbers and any `demo.NN` username are on Signal;
   * everyone else isn't. A found stranger becomes a contact, so a first
   * message can reach them.
   */
  async lookupRecipient(query: RecipientQuery): Promise<RecipientLookup> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    if (this.lookupRateLimited) return { status: 'rate-limited' };
    const known = [...this.world.contacts.values()].find(
      (c) => !c.isSelf && query.kind === 'phone' && c.number === query.e164,
    );
    if (known) {
      return {
        status: 'found',
        id: known.id,
        name: known.name,
        ...(known.number ? { number: known.number } : {}),
      };
    }
    const registered =
      query.kind === 'phone'
        ? /^\+1202555019\d$/u.test(query.e164)
        : /^demo\.\d{2,}$/u.test(query.username);
    if (!registered) return { status: 'not-registered' };
    const label = query.kind === 'phone' ? query.e164 : query.username;
    const existing = [...this.world.contacts.values()].find((c) => c.name === label);
    const stranger = existing ?? {
      id: this.rnd.uuid(),
      name: label,
      color: '',
      ...(query.kind === 'phone' ? { number: query.e164 } : {}),
    };
    if (!existing) {
      stranger.color = colorForId(stranger.id);
      this.world.contacts.set(stranger.id, stranger);
    }
    return {
      status: 'found',
      id: stranger.id,
      name: stranger.name,
      ...(stranger.number ? { number: stranger.number } : {}),
      ...(query.kind === 'username' ? { username: query.username } : {}),
    };
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const conv = this.requireConversation(input.conversationId, true);

    const sentAt = Math.max(this.clock.now(), this.lastSentAt + 1);
    this.lastSentAt = sentAt;
    // Like signal-cli's adapter for small own sends: nothing echoes our bytes
    // back, so keep them as a data: URL the UI can render after a reload.
    const attachments: Attachment[] = await Promise.all(
      (input.attachments ?? []).map(async (a, i) => ({
        id: `${sentAt.toString(36)}-${i}`,
        contentType: a.contentType,
        fileName: a.fileName,
        size: a.data.size,
        ...(a.width !== undefined ? { width: a.width } : {}),
        ...(a.height !== undefined ? { height: a.height } : {}),
        ...(a.data.size <= INLINE_ATTACHMENT_MAX
          ? { url: await toDataUrl(a.data, a.contentType) }
          : {}),
      })),
    );
    const preview: LinkPreview | undefined = input.preview && {
      url: input.preview.url,
      title: input.preview.title,
      ...(input.preview.description ? { description: input.preview.description } : {}),
      ...(input.preview.image
        ? {
            image: {
              id: `${sentAt.toString(36)}-preview`,
              contentType: input.preview.image.contentType,
              size: input.preview.image.data.size,
              ...(input.preview.image.width !== undefined
                ? { width: input.preview.image.width }
                : {}),
              ...(input.preview.image.height !== undefined
                ? { height: input.preview.image.height }
                : {}),
              ...(input.preview.image.data.size <= INLINE_ATTACHMENT_MAX
                ? {
                    url: await toDataUrl(input.preview.image.data, input.preview.image.contentType),
                  }
                : {}),
            },
          }
        : {}),
    };
    const selfId = this.world.self.id;
    const message: Message = {
      id: messageId(selfId, sentAt),
      conversationId: conv.id,
      authorId: selfId,
      sentAt,
      receivedAt: sentAt,
      body: input.body,
      ranges: input.ranges,
      attachments,
      reactions: [],
      status: 'sent',
      kind: 'normal',
    };
    if (input.quote) message.quote = input.quote;
    if (preview) message.previews = [preview];
    if (input.sticker) message.sticker = input.sticker;
    this.append(message);
    this.scheduleReceipts(conv, sentAt);
    if (conv.kind === 'direct') this.liveliness.replyTo(conv.id);
    return { sentAt, attachments, ...(preview ? { preview } : {}) };
  }

  /** The demo's attachments carry their bytes in a `data:` URL; decoded here, like a download. */
  async readAttachmentBlob(
    _conversationId: ConversationId,
    attachment: Attachment,
    options?: { maxBytes?: number },
  ): Promise<Blob> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const match = /^data:([^;,]*);base64,(.*)$/u.exec(attachment.url ?? '');
    if (!match) throw new MockBackendError('Attachment not available');
    const bytes = Uint8Array.from(atob(match[2] ?? ''), (c) => c.charCodeAt(0));
    if (options?.maxBytes !== undefined && bytes.length > options.maxBytes)
      throw new MockBackendError('Attachment is too large');
    return new Blob([bytes], { type: match[1] ?? '' });
  }

  /** The demo packs the user has installed (the rest only show in a pack dialog). */
  private readonly installedPacks = new Set(
    MOCK_STICKER_PACKS.filter((p) => p.installed).map((p) => p.packId),
  );

  private packDetails(pack: MockStickerPack): StickerPackDetails {
    const stickers = pack.emoji.map((emoji, stickerId) => ({
      stickerId,
      emoji,
      url: generateStickerUrl(emoji),
    }));
    return {
      packId: pack.packId,
      title: pack.title,
      author: pack.author,
      installed: this.installedPacks.has(pack.packId),
      cover: stickers[0] ?? { stickerId: 0, emoji: '' },
      stickers,
    };
  }

  async listStickerPacks(): Promise<StickerPackInfo[]> {
    await this.delay();
    this.assertOnline();
    return MOCK_STICKER_PACKS.filter((p) => this.installedPacks.has(p.packId)).map((pack) => {
      const { installed: _installed, ...info } = this.packDetails(pack);
      return info;
    });
  }

  async getStickerPack(sticker: StickerContent): Promise<StickerPackDetails> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const pack = MOCK_STICKER_PACKS.find((p) => p.packId === sticker.packId);
    if (!pack) throw new MockBackendError('Sticker pack not found');
    return this.packDetails(pack);
  }

  supportsStickerPackInstall(): boolean {
    return true;
  }

  async installStickerPack(sticker: StickerContent): Promise<void> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    if (!MOCK_STICKER_PACKS.some((p) => p.packId === sticker.packId))
      throw new MockBackendError('Sticker pack not found');
    this.installedPacks.add(sticker.packId);
  }

  async edit(input: EditInput): Promise<{ sentAt: number }> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const editedAt = Math.max(this.clock.now(), this.lastSentAt + 1);
    this.lastSentAt = editedAt;
    this.updateMessage(input.conversationId, this.world.self.id, input.targetSentAt, (m) =>
      applyEdit(m, { body: input.body, ranges: input.ranges, editedAt }),
    );
    return { sentAt: editedAt };
  }

  async react(input: ReactInput): Promise<void> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const reaction = { emoji: input.emoji, authorId: this.world.self.id, at: this.clock.now() };
    this.updateMessage(input.conversationId, input.targetAuthorId, input.targetSentAt, (m) => ({
      ...m,
      reactions: applyReaction(m.reactions, reaction, input.remove),
    }));
  }

  async deleteForEveryone(conversationId: ConversationId, sentAt: number): Promise<void> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    this.updateMessage(conversationId, this.world.self.id, sentAt, applyDelete);
  }

  async adminDelete(conversationId: ConversationId, target: MessageRef): Promise<void> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const conv = this.requireConversation(conversationId);
    if (!conv.adminIds.includes(this.world.self.id))
      throw new MockBackendError('Not a group admin');
    this.updateMessage(conversationId, target.authorId, target.sentAt, (m) =>
      applyDelete(m, this.world.self.id),
    );
  }

  async pinMessage(input: PinInput): Promise<void> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    this.updateMessage(input.conversationId, input.targetAuthorId, input.targetSentAt, (m) => ({
      ...m,
      pinned: input.pin,
    }));
  }

  supportsReadSync(): boolean {
    return this.readSyncSupported;
  }

  supportsCatchingUpSignal(): boolean {
    return this.catchingUpSignalSupported;
  }

  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    await this.delay();
    this.typingSent.push({ conversationId, typing });
  }

  async markRead(
    conversationId: ConversationId,
    messages: { authorId: string; sentAt: number }[],
    options?: MarkReadOptions,
  ): Promise<ReadSummary | undefined> {
    await this.delay();
    if (options?.syncOnly && !this.readSyncSupported) return undefined;
    this.readReceiptsSent.push({
      conversationId,
      messages: structuredClone(messages),
      ...(options?.syncOnly ? { syncOnly: true as const } : {}),
    });
    const latest = Math.max(
      ...messages.map((m) => m.sentAt),
      this.world.readUpTo.get(conversationId) ?? 0,
    );
    this.world.readUpTo.set(conversationId, latest);
    return this.readSummary;
  }

  /**
   * Accepting shares the user's profile (the contact's `profileSharing`, as
   * signal-cli reports it); deleting drops the conversation, group or not.
   */
  async respondToMessageRequest(
    conversationId: ConversationId,
    response: MessageRequestResponse,
  ): Promise<void> {
    await this.delay();
    this.assertOnline();
    const conv = this.requireConversation(conversationId);
    this.requestResponses.push({ conversationId, response });
    if (response === 'delete') {
      this.world.conversations.delete(conversationId);
      this.world.histories.delete(conversationId);
      return;
    }
    const peer =
      conv.kind === 'direct' ? conv.memberIds.find((id) => id !== this.world.self.id) : undefined;
    this.updateContact(peer, { profileSharing: true });
  }

  async setBlocked(conversationId: ConversationId, blocked: boolean): Promise<void> {
    await this.delay();
    this.assertOnline();
    const conv = this.requireConversation(conversationId);
    this.requestResponses.push({ conversationId, response: blocked ? 'block' : 'unblock' });
    if (conv.kind === 'group') {
      const next: Conversation = { ...conv, blocked };
      if (!blocked) delete next.blocked;
      this.world.conversations.set(conversationId, next);
      this.emitter.emit('conversationUpdated', structuredClone(next));
      return;
    }
    const peer = conv.memberIds.find((id) => id !== this.world.self.id);
    // Unblocking is also accepting, like Signal's own clients.
    this.updateContact(peer, { blocked, ...(blocked ? {} : { profileSharing: true }) });
  }

  private updateContact(id: string | undefined, patch: Partial<Contact>): void {
    const contact = id === undefined ? undefined : this.world.contacts.get(id);
    if (!contact) return;
    const next: Contact = { ...contact, ...patch };
    if (next.blocked === false) delete next.blocked;
    this.world.contacts.set(contact.id, next);
    this.emitter.emit('contactUpdated', structuredClone(next));
  }

  supportsAttachmentBackfill(): boolean {
    return true;
  }

  /**
   * Simulates the phone's two-step answer (patches/signal-cli, "0016:
   * attachment backfill"): a `pending` event right away, then `ready` after
   * a short delay, through the same scheduler as everything else here — so
   * a test with a fake scheduler can advance straight through it, and a
   * real demo session shows the "Getting it from your phone…" state for a
   * moment before the attachment resolves.
   */
  async requestAttachmentBackfill(
    _conversationId: ConversationId,
    targetAuthorId: string,
    targetSentAt: number,
    attachmentIds: readonly string[],
  ): Promise<void> {
    await this.delay();
    this.emitter.emit('attachmentBackfill', {
      targetAuthorId,
      targetSentAt,
      status: 'pending',
      attachmentIds,
    });
    this.scheduler.setTimeout(() => {
      this.emitter.emit('attachmentBackfill', {
        targetAuthorId,
        targetSentAt,
        status: 'ready',
        attachmentIds,
      });
    }, 1_500);
  }

  async updateConversation(
    conversationId: ConversationId,
    patch: ConversationPatch,
  ): Promise<void> {
    await this.delay();
    this.assertOnline();
    const conv = this.requireConversation(conversationId);
    const next: Conversation = { ...conv, ...patch };
    this.world.conversations.set(conversationId, next);
    this.emitter.emit('conversationUpdated', structuredClone(next));
    // Like signal-cli's adapter: nothing echoes our own change, so author the line here.
    const lines: string[] = [];
    if (patch.title !== undefined && patch.title !== conv.title)
      lines.push(`You changed the group name to "${patch.title}".`);
    if (patch.expireTimerSec !== undefined && patch.expireTimerSec !== conv.expireTimerSec)
      lines.push(
        patch.expireTimerSec > 0
          ? `You set disappearing messages to ${formatDuration(patch.expireTimerSec)}.`
          : 'You turned off disappearing messages.',
      );
    if (lines.length > 0) {
      const sentAt = Math.max(this.clock.now(), this.lastSentAt + 1);
      this.lastSentAt = sentAt;
      const selfId = this.world.self.id;
      this.deliver({
        id: messageId(selfId, sentAt),
        conversationId,
        authorId: selfId,
        sentAt,
        receivedAt: sentAt,
        body: '',
        ranges: [],
        attachments: [],
        reactions: [],
        status: 'sent',
        kind: 'system',
        systemText: lines.join(' '),
      });
    }
  }

  // ─── Test & demo hooks (not part of ChatBackend) ───────────────────────

  /** Makes the next command reject, to exercise failure/retry paths. */
  failNext(error: Error = new MockBackendError('Simulated network failure')): void {
    this.failures.push(error);
  }

  /** Injects an incoming message as if it arrived from the network. */
  deliver(message: Message): void {
    this.append(message);
    this.emitter.emit('message', structuredClone(message));
  }

  /** Emits an arbitrary backend event (tests). */
  emit<E extends keyof BackendEvents>(event: E, payload: BackendEvents[E]): void {
    this.emitter.emit(event, payload);
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit('status', status);
  }

  private delay(): Promise<void> {
    if (this.latencyMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, this.latencyMs);
    });
  }

  private assertOnline(): void {
    if (this.status !== 'online') throw new MockBackendError('Not connected');
  }

  private takeFailure(): void {
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  /**
   * `openDirect`: a send to a person the user has no DM with yet (one found
   * through `lookupRecipient`, or a contact never written to) starts it, as
   * Signal does: the conversation exists once a message does.
   */
  private requireConversation(id: ConversationId, openDirect = false): Conversation {
    const existing = this.world.conversations.get(id);
    if (existing) return existing;
    const peer = openDirect ? parseConversationId(id) : null;
    if (peer?.kind === 'direct' && this.world.contacts.has(peer.target)) {
      const conv: Conversation = {
        id: directConversationId(peer.target),
        kind: 'direct',
        title: this.world.contacts.get(peer.target)?.name ?? peer.target,
        memberIds: [this.world.self.id, peer.target],
        adminIds: [],
        expireTimerSec: 0,
        lastActivityAt: this.clock.now(),
      };
      this.world.conversations.set(conv.id, conv);
      this.world.histories.set(conv.id, []);
      this.emitter.emit('conversationUpdated', structuredClone(conv));
      return conv;
    }
    throw new MockBackendError(`Unknown conversation ${id}`);
  }

  private append(message: Message): void {
    const history = this.world.histories.get(message.conversationId);
    if (!history) return;
    history.push(message);
    const conv = this.world.conversations.get(message.conversationId);
    if (conv) conv.lastActivityAt = Math.max(conv.lastActivityAt, message.sentAt);
  }

  private updateMessage(
    conversationId: ConversationId,
    authorId: string,
    sentAt: number,
    fn: (m: Message) => Message,
  ): void {
    const history = this.world.histories.get(conversationId);
    const index = history?.findIndex((m) => m.authorId === authorId && m.sentAt === sentAt) ?? -1;
    if (!history || index === -1) throw new MockBackendError('Message not found');
    history[index] = fn(history[index] as Message);
  }

  private scheduleReceipts(conv: Conversation, sentAt: number): void {
    const recipients = conv.memberIds.filter((id) => id !== this.world.self.id);
    const first = recipients[0];
    if (first === undefined) return;
    this.scheduler.setTimeout(() => {
      this.emitter.emit('receipt', { authorId: first, sentAts: [sentAt], type: 'delivered' });
    }, 600);
    this.scheduler.setTimeout(
      () => {
        this.emitter.emit('receipt', { authorId: first, sentAts: [sentAt], type: 'read' });
      },
      2_500 + this.rnd.int(0, 3_500),
    );
  }
}

/** Own attachments up to this size are kept inline (mirrors the signal-cli adapter). */
const INLINE_ATTACHMENT_MAX = 1_500_000;

async function toDataUrl(blob: Blob, contentType: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return `data:${contentType || 'application/octet-stream'};base64,${btoa(binary)}`;
}
