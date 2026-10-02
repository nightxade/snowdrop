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
  messageId,
  type Attachment,
  type ConnectionStatus,
  type Contact,
  type Conversation,
  type ConversationId,
  type Message,
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
  MessageRef,
  PinInput,
  ReactInput,
  SendResult,
  SendInput,
} from '../types';
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

  constructor(options: MockBackendOptions = {}) {
    const seed = options.seed ?? 42;
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.latencyMs = options.latencyMs ?? 0;
    this.rnd = new Random(seed ^ 0x5eed);
    this.world = options.world ?? buildWorld({ seed, now: this.clock.now() });
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

  // ─── Commands ──────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult> {
    await this.delay();
    this.assertOnline();
    this.takeFailure();
    const conv = this.requireConversation(input.conversationId);

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
    this.append(message);
    this.scheduleReceipts(conv, sentAt);
    if (conv.kind === 'direct') this.liveliness.replyTo(conv.id);
    return { sentAt, attachments };
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

  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    await this.delay();
    this.typingSent.push({ conversationId, typing });
  }

  async markRead(
    conversationId: ConversationId,
    messages: { authorId: string; sentAt: number }[],
  ): Promise<void> {
    await this.delay();
    const latest = Math.max(
      ...messages.map((m) => m.sentAt),
      this.world.readUpTo.get(conversationId) ?? 0,
    );
    this.world.readUpTo.set(conversationId, latest);
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

  private requireConversation(id: ConversationId): Conversation {
    const conv = this.world.conversations.get(id);
    if (!conv) throw new MockBackendError(`Unknown conversation ${id}`);
    return conv;
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
