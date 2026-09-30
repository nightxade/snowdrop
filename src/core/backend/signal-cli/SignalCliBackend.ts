/**
 * ChatBackend over a local signal-cli daemon (`signal-cli daemon --http`).
 *
 * - Commands go through `JsonRpcClient` (POST /api/v1/rpc).
 * - Incoming envelopes arrive on the SSE stream (GET /api/v1/events), are
 *   validated and normalised by pure functions, and are then applied *in
 *   order* through one promise queue — some need a daemon round-trip first
 *   (a group update is re-listed and diffed) and must not be overtaken by the
 *   message that follows them.
 * - signal-cli keeps no message history and has no DM list; the repository
 *   owns history, and `DirectPeers` remembers who we've talked to.
 * - Multi-account daemons are supported: the chosen account is sent as the
 *   `account` param and `?account=` on the event stream.
 */
import {
  colorForId,
  directConversationId,
  parseConversationId,
  type Attachment,
  type ConnectionStatus,
  type Contact,
  type Conversation,
  type ConversationId,
} from '@/core/domain';
import {
  Emitter,
  systemClock,
  systemScheduler,
  type Clock,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import type { KeyValueStorage } from '@/core/persistence';
import type {
  BackendEvents,
  ChatBackend,
  ConversationPatch,
  EditInput,
  LinkFlow,
  MessageRef,
  PinInput,
  ReactInput,
  SendInput,
  SendResult,
} from '../types';
import { AttachmentResolver, encodeOutgoing } from './attachments';
import { SignalCliError } from './errors';
import {
  describeGroupChange,
  toContact,
  toDirectConversation,
  toGroupConversation,
} from './normalise/directory';
import { normaliseReceive } from './normalise/envelope';
import { systemMessage } from './normalise/content';
import type { AdapterEvent, NormaliseContext } from './normalise/types';
import { enrichSendError, messageParams, recipientFailures, targetParams } from './params';
import { JsonRpcClient, joinUrl, type FetchLike, type RpcParams } from './rpc';
import { EventStream, type EventStreamState, type SseEvent } from './sse';
import { unknownValue } from './validate';
import { DirectPeers } from './peers';
import {
  wireAccounts,
  wireContacts,
  wireFinishLink,
  wireGroups,
  wireSendResult,
  wireStartLink,
  type WireAccount,
} from './wire';

export interface SignalCliBackendOptions {
  /** Daemon base URL: `/signal-cli` behind the Vite proxy, or `http://127.0.0.1:8080`. */
  baseUrl: string;
  /** Preferred account (number or ACI); the only/first account is used otherwise. */
  account?: string | null;
  fetch?: FetchLike;
  clock?: Clock;
  scheduler?: Scheduler;
  random?: () => number;
  /** Persists DM peers and the SSE resume position. */
  storage?: KeyValueStorage;
  /** Called with the account in use after connect/link, so settings can remember it. */
  onAccountSelected?: (account: string) => void;
  debug?: (message: string, detail?: unknown) => void;
  rpcTimeoutMs?: number;
  stream?: { initialDelayMs?: number; maxDelayMs?: number; idleTimeoutMs?: number };
}

/** Directory data is re-used this long so connect + initial sync don't list twice. */
const DIRECTORY_TTL_MS = 5_000;
/** finishLink blocks until the phone scans the code. */
const LINK_TIMEOUT_MS = 10 * 60_000;

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

export class SignalCliBackend implements ChatBackend {
  readonly kind = 'signal-cli' as const;
  readonly link: LinkFlow;

  private readonly rpc: JsonRpcClient;
  private readonly emitter = new Emitter<BackendEvents>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly attachments: AttachmentResolver;
  private readonly debugLog: (message: string, detail?: unknown) => void;

  private status: ConnectionStatus = 'offline';
  private preferredAccount: string | null;
  private stream: EventStream | null = null;
  private connecting: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped on disconnect so queued work from an old session is dropped. */
  private session = 0;

  // Per-account state, set on connect.
  private selfId = '';
  private selfNumber: string | undefined;
  private selfAliases = new Set<string>();
  private peers: DirectPeers | null = null;
  private readonly contacts = new Map<string, Contact>();
  /** DM disappearing timers come from the contact record. */
  private readonly dmTimers = new Map<string, number>();
  private readonly groups = new Map<ConversationId, Conversation>();
  private contactsLoadedAt = -Infinity;
  private groupsLoadedAt = -Infinity;

  constructor(private readonly options: SignalCliBackendOptions) {
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.preferredAccount = options.account ?? null;
    this.debugLog =
      options.debug ??
      ((message, detail) => {
        console.debug(`[hearth] signal-cli: ${message}`, detail ?? '');
      });
    this.rpc = new JsonRpcClient({
      baseUrl: options.baseUrl,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.rpcTimeoutMs === undefined ? {} : { timeoutMs: options.rpcTimeoutMs }),
    });
    this.attachments = new AttachmentResolver({ rpc: this.rpc });
    this.link = {
      start: async () => {
        const { deviceLinkUri } = await this.rpc.call('startLink', undefined, wireStartLink, {
          account: null,
        });
        return { uri: deviceLinkUri };
      },
      finish: async (uri, deviceName) => {
        const result = await this.rpc.call(
          'finishLink',
          { deviceLinkUri: uri, deviceName },
          wireFinishLink,
          { account: null, timeoutMs: LINK_TIMEOUT_MS },
        );
        const accountId = result.aci ?? result.number;
        if (!accountId)
          throw new SignalCliError('invalid-response', 'finishLink returned no account');
        this.preferredAccount = accountId;
        this.options.onAccountSelected?.(accountId);
        return { accountId };
      },
    };
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  connect(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    if (this.stream) return;
    this.setStatus('connecting');
    try {
      await this.rpc.check({ timeoutMs: 5_000 });
      const accounts = await this.rpc.call('listAccounts', undefined, wireAccounts, {
        account: null,
      });
      const account = this.chooseAccount(accounts);
      this.selectAccount(account);
      await this.loadDirectory(true);
      this.openStream();
    } catch (error) {
      this.setStatus('error');
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    this.session++;
    const stream = this.stream;
    this.stream = null;
    await stream?.stop();
    this.attachments.clear();
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

  /** The account param in use (after connect). */
  get account(): string | undefined {
    return this.rpc.account;
  }

  private chooseAccount(accounts: WireAccount[]): WireAccount {
    const usable = accounts.filter((a) => a.aci ?? a.number);
    const preferred = this.preferredAccount;
    const match = preferred
      ? usable.find((a) => a.aci === preferred || a.number === preferred)
      : undefined;
    const chosen = match ?? usable[0];
    if (!chosen) {
      throw new SignalCliError(
        'no-account',
        'signal-cli has no account yet. Link this device to your phone to continue.',
      );
    }
    if (preferred && !match) this.debugLog(`account ${preferred} not found; using the first one`);
    return chosen;
  }

  private selectAccount(account: WireAccount): void {
    // Prefer the ACI: numberless accounts exist, and numbers can change.
    const param = account.aci ?? account.number ?? '';
    this.rpc.account = param;
    this.selfId = param;
    this.selfNumber = account.number;
    this.selfAliases = new Set([account.aci, account.number].filter((x): x is string => !!x));
    this.peers = new DirectPeers(this.options.storage, param);
    this.contacts.clear();
    this.groups.clear();
    this.dmTimers.clear();
    this.contactsLoadedAt = -Infinity;
    this.groupsLoadedAt = -Infinity;
    if (param !== this.preferredAccount) this.options.onAccountSelected?.(param);
    this.preferredAccount = param;
  }

  private lastEventIdKey(): string {
    return `hearth.signal-cli.lastEventId.${this.selfId}`;
  }

  private openStream(): void {
    const session = this.session;
    const url = joinUrl(
      this.options.baseUrl,
      `/api/v1/events?account=${encodeURIComponent(this.selfId)}`,
    );
    let lastEventId = '';
    try {
      lastEventId = this.options.storage?.getItem(this.lastEventIdKey()) ?? '';
    } catch {
      // Storage unavailable: start from live events.
    }
    const stream = new EventStream({
      url,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      scheduler: this.scheduler,
      ...(this.options.random ? { random: this.options.random } : {}),
      ...this.options.stream,
      lastEventId,
      onEvent: (event) => {
        if (session === this.session) this.onSse(event);
      },
      onState: (state) => {
        if (session === this.session) this.onStreamState(state);
      },
    });
    this.stream = stream;
    stream.start();
  }

  private onStreamState(state: EventStreamState): void {
    switch (state.kind) {
      case 'open':
        this.setStatus('online');
        break;
      case 'connecting':
        if (this.status !== 'offline') this.setStatus('connecting');
        break;
      case 'waiting':
        // A blip reads as "connecting"; repeated failures as "offline".
        this.setStatus(state.attempt >= 2 ? 'offline' : 'connecting');
        this.debugLog(`event stream retry in ${state.delayMs} ms`, state.error);
        break;
      case 'failed':
        this.debugLog('event stream failed', state.error);
        this.setStatus('error');
        break;
      case 'closed':
        break;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emitter.emit('status', status);
  }

  // ─── Incoming events ───────────────────────────────────────────────────

  private onSse(event: SseEvent): void {
    if (event.type !== 'receive') {
      this.debugLog(`ignored SSE event "${event.type}"`);
      return;
    }
    try {
      this.options.storage?.setItem(this.lastEventIdKey(), event.lastEventId);
    } catch {
      // Resume position is an optimisation only.
    }
    let payload: unknown;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.debugLog('ignored non-JSON SSE data', event.data.slice(0, 200));
      return;
    }
    const events = normaliseReceive(payload, this.normaliseContext());
    if (events.length > 0) this.enqueue(events);
  }

  private normaliseContext(): NormaliseContext {
    return {
      selfId: this.selfId,
      selfAliases: this.selfAliases,
      now: this.clock.now(),
      nameOf: (id) => this.contacts.get(id)?.name,
      debug: this.debugLog,
    };
  }

  /** Test hook: feeds a raw `receive` payload as if it came from the stream. */
  ingest(payload: unknown): Promise<void> {
    const events = normaliseReceive(payload, this.normaliseContext());
    this.enqueue(events);
    return this.queue;
  }

  /** Resolves once every queued incoming event has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  private enqueue(events: AdapterEvent[]): void {
    const session = this.session;
    this.queue = this.queue.then(async () => {
      for (const event of events) {
        if (session !== this.session) return;
        try {
          await this.apply(event);
        } catch (error) {
          this.debugLog(`failed to apply ${event.kind}`, error);
        }
      }
    });
  }

  private async apply(event: AdapterEvent): Promise<void> {
    switch (event.kind) {
      case 'message': {
        const message = event.payload;
        this.notePeer(message.conversationId, message.receivedAt);
        this.emitter.emit('message', message);
        return;
      }
      case 'expirationChanged':
        this.applyTimer(event.conversationId, event.seconds);
        return;
      case 'groupChanged':
        await this.applyGroupChange(event);
        return;
      case 'contactsChanged':
        await this.refreshContacts();
        return;
      case 'messageEdited':
        this.emitter.emit('messageEdited', event.payload);
        return;
      case 'messageDeleted':
        this.emitter.emit('messageDeleted', event.payload);
        return;
      case 'messagePinned':
        this.emitter.emit('messagePinned', event.payload);
        return;
      case 'reaction':
        this.emitter.emit('reaction', event.payload);
        return;
      case 'receipt':
        this.emitter.emit('receipt', event.payload);
        return;
      case 'typing':
        this.emitter.emit('typing', event.payload);
        return;
      case 'readSync':
        this.emitter.emit('readSync', event.payload);
        return;
    }
  }

  /** Remembers a DM peer; announces the conversation the first time we see it. */
  private notePeer(conversationId: ConversationId, at: number): void {
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind !== 'direct' || !this.peers) return;
    if (this.peers.touch(parsed.target, at)) {
      this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, at));
    }
  }

  private directConversation(peerId: string, lastActivityAt: number): Conversation {
    return toDirectConversation(
      peerId,
      this.selfId,
      this.contacts.get(peerId),
      this.dmTimers.get(peerId) ?? 0,
      lastActivityAt,
    );
  }

  private applyTimer(conversationId: ConversationId, seconds: number): void {
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    if (parsed.kind === 'direct') {
      this.dmTimers.set(parsed.target, seconds);
      this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, 0));
      return;
    }
    const group = this.groups.get(conversationId);
    if (!group) return;
    const next = { ...group, expireTimerSec: seconds };
    this.groups.set(conversationId, next);
    this.emitter.emit('conversationUpdated', next);
  }

  private async applyGroupChange(
    event: Extract<AdapterEvent, { kind: 'groupChanged' }>,
  ): Promise<void> {
    const before = this.groups.get(event.conversationId);
    const [raw] = await this.rpc.call('listGroups', { groupId: [event.groupId] }, wireGroups);
    if (!raw || !raw.isMember) {
      // We left or were removed; keep history, just note it.
      this.emitter.emit(
        'message',
        this.groupSystemMessage(event, 'You are no longer a member of this group.'),
      );
      return;
    }
    const after = toGroupConversation(raw, (id) => this.resolveId(id), 0);
    this.groups.set(after.id, after);
    this.emitter.emit('conversationUpdated', after);

    const actorName = this.nameOf(event.actorId);
    let lines: string[];
    if (!before) {
      lines = [
        event.actorId === this.selfId
          ? 'You updated the group.'
          : `${actorName} added you to the group.`,
      ];
    } else {
      lines = describeGroupChange(before, after, actorName, (id) => this.nameOf(id));
      if (lines.length === 0) lines = [`${actorName} updated the group settings.`];
    }
    this.emitter.emit('message', this.groupSystemMessage(event, lines.join(' ')));
  }

  private groupSystemMessage(event: Extract<AdapterEvent, { kind: 'groupChanged' }>, text: string) {
    return systemMessage(
      {
        conversationId: event.conversationId,
        authorId: event.actorId,
        receivedAt: this.clock.now(),
      },
      event.sentAt,
      text,
    );
  }

  private nameOf(id: string): string {
    if (id === this.selfId) return 'You';
    return this.contacts.get(id)?.name ?? id;
  }

  private resolveId(id: string): string {
    return this.selfAliases.has(id) ? this.selfId : id;
  }

  // ─── Directory ─────────────────────────────────────────────────────────

  private async loadDirectory(force = false): Promise<void> {
    await Promise.all([this.loadContacts(force), this.loadGroups(force)]);
  }

  private async loadContacts(force = false): Promise<Contact[]> {
    const now = this.clock.now();
    if (force || now - this.contactsLoadedAt > DIRECTORY_TTL_MS) {
      // allRecipients: group members we've never messaged still get names.
      const raw = await this.rpc.call('listContacts', { allRecipients: true }, wireContacts);
      this.contacts.clear();
      this.dmTimers.clear();
      for (const c of raw) {
        const contact = toContact(c, this.selfId);
        if (!contact) continue;
        const id = this.resolveId(contact.id);
        this.contacts.set(id, id === contact.id ? contact : { ...contact, id, isSelf: true });
        if (c.messageExpirationTime > 0) this.dmTimers.set(id, c.messageExpirationTime);
      }
      this.contactsLoadedAt = now;
    }
    return [...this.contacts.values()];
  }

  private async loadGroups(force = false): Promise<Conversation[]> {
    const now = this.clock.now();
    if (force || now - this.groupsLoadedAt > DIRECTORY_TTL_MS) {
      const raw = await this.rpc.call('listGroups', undefined, wireGroups);
      this.groups.clear();
      for (const g of raw) {
        if (!g.isMember) continue;
        const conv = toGroupConversation(g, (id) => this.resolveId(id), 0);
        this.groups.set(conv.id, conv);
      }
      this.groupsLoadedAt = now;
    }
    return [...this.groups.values()];
  }

  /** After a contacts sync: re-list and announce what changed. */
  private async refreshContacts(): Promise<void> {
    const before = new Map(this.contacts);
    await this.loadContacts(true);
    for (const contact of this.contacts.values()) {
      const prev = before.get(contact.id);
      if (prev && JSON.stringify(prev) === JSON.stringify(contact)) continue;
      this.emitter.emit('contactUpdated', contact);
      if (this.peers?.has(contact.id)) {
        this.emitter.emit('conversationUpdated', this.directConversation(contact.id, 0));
      }
    }
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  async getSelf(): Promise<Contact> {
    this.assertAccount();
    await this.loadContacts();
    const known = this.contacts.get(this.selfId);
    const self: Contact = known
      ? { ...known, isSelf: true }
      : {
          id: this.selfId,
          name: this.selfNumber ?? 'You',
          color: colorForId(this.selfId),
          isSelf: true,
        };
    if (this.selfNumber && !self.number) self.number = this.selfNumber;
    return self;
  }

  async listContacts(): Promise<Contact[]> {
    this.assertAccount();
    const contacts = await this.loadContacts();
    return contacts.filter((c) => c.id !== this.selfId);
  }

  async listConversations(): Promise<Conversation[]> {
    this.assertAccount();
    const [groups] = await Promise.all([this.loadGroups(), this.loadContacts()]);
    const dms = (this.peers?.entries() ?? []).map(([peer, at]) =>
      this.directConversation(peer, at),
    );
    return [...groups, ...dms];
  }

  async resolveAttachmentUrl(
    _conversationId: ConversationId,
    attachment: Attachment,
  ): Promise<string> {
    this.assertAccount();
    return this.attachments.resolve(attachment);
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult> {
    this.assertAccount();
    const target = targetParams(input.conversationId, this.selfAliases);
    const stamp = this.clock.now().toString(36);
    const encoded = await Promise.all(
      (input.attachments ?? []).map((file, i) => encodeOutgoing(file, `local:${stamp}:${i}`)),
    );
    const params = {
      ...target,
      ...messageParams({
        body: input.body,
        ranges: input.ranges,
        ...(input.quote ? { quote: input.quote } : {}),
        attachments: encoded.map((e) => e.param),
      }),
    };
    let result;
    try {
      result = await this.rpc.call('send', params, wireSendResult, {
        timeoutMs: encoded.length > 0 ? 180_000 : 60_000,
      });
    } catch (error) {
      throw enrichSendError(error);
    }
    const failures = recipientFailures(result);
    this.notePeer(input.conversationId, this.clock.now());
    const out: SendResult = { sentAt: result.timestamp };
    if (encoded.length > 0) out.attachments = encoded.map((e) => e.attachment);
    if (failures.length > 0) out.recipientFailures = failures;
    return out;
  }

  async edit(input: EditInput): Promise<{ sentAt: number }> {
    this.assertAccount();
    const params = {
      ...targetParams(input.conversationId, this.selfAliases),
      ...messageParams({
        body: input.body,
        ranges: input.ranges,
        editTimestamp: input.targetSentAt,
      }),
    };
    try {
      const result = await this.rpc.call('send', params, wireSendResult, { timeoutMs: 60_000 });
      return { sentAt: result.timestamp };
    } catch (error) {
      throw enrichSendError(error);
    }
  }

  async react(input: ReactInput): Promise<void> {
    await this.command('sendReaction', input.conversationId, {
      emoji: input.emoji,
      targetAuthor: input.targetAuthorId,
      targetTimestamp: input.targetSentAt,
      remove: input.remove,
    });
  }

  async deleteForEveryone(conversationId: ConversationId, sentAt: number): Promise<void> {
    await this.command('remoteDelete', conversationId, { targetTimestamp: sentAt });
  }

  async adminDelete(conversationId: ConversationId, target: MessageRef): Promise<void> {
    if (parseConversationId(conversationId)?.kind !== 'group') {
      throw new SignalCliError('user', 'Admin delete is only possible in groups');
    }
    await this.command('sendAdminDelete', conversationId, {
      targetAuthor: target.authorId,
      targetTimestamp: target.sentAt,
    });
  }

  async pinMessage(input: PinInput): Promise<void> {
    const params: RpcParams = {
      targetAuthor: input.targetAuthorId,
      targetTimestamp: input.targetSentAt,
    };
    if (input.pin) {
      params.pinDuration = input.durationSec ?? -1;
      await this.command('sendPinMessage', input.conversationId, params);
    } else {
      await this.command('sendUnpinMessage', input.conversationId, params);
    }
  }

  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    this.assertAccount();
    const target = targetParams(conversationId, this.selfAliases);
    if ('noteToSelf' in target) return;
    await this.rpc.call('sendTyping', { ...target, stop: !typing }, ignoreResult);
  }

  async markRead(_conversationId: ConversationId, messages: MessageRef[]): Promise<void> {
    this.assertAccount();
    // Receipts are addressed to each message's author, not to the conversation.
    const byAuthor = new Map<string, number[]>();
    for (const m of messages) {
      if (this.selfAliases.has(m.authorId) || m.authorId === this.selfId) continue;
      byAuthor.set(m.authorId, [...(byAuthor.get(m.authorId) ?? []), m.sentAt]);
    }
    await Promise.all(
      [...byAuthor].map(([author, timestamps]) =>
        this.rpc.call(
          'sendReceipt',
          { recipient: author, targetTimestamp: timestamps, type: 'read' },
          ignoreResult,
        ),
      ),
    );
  }

  async updateConversation(
    conversationId: ConversationId,
    patch: ConversationPatch,
  ): Promise<void> {
    this.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    if (parsed.kind === 'direct') {
      if (patch.title !== undefined || patch.description !== undefined) {
        throw new SignalCliError('user', 'Direct conversations have no editable name or topic');
      }
      if (patch.expireTimerSec === undefined) return;
      await this.rpc.call(
        'updateContact',
        { recipient: parsed.target, expiration: patch.expireTimerSec },
        ignoreResult,
      );
      this.applyTimer(directConversationId(parsed.target), patch.expireTimerSec);
      return;
    }
    const params: RpcParams = { groupId: parsed.target };
    if (patch.title !== undefined) params.name = patch.title;
    if (patch.description !== undefined) params.description = patch.description;
    if (patch.expireTimerSec !== undefined) params.expiration = patch.expireTimerSec;
    await this.rpc.call('updateGroup', params, ignoreResult);
    const current = this.groups.get(conversationId);
    if (current) {
      const next: Conversation = { ...current };
      if (patch.title !== undefined) next.title = patch.title;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.expireTimerSec !== undefined) next.expireTimerSec = patch.expireTimerSec;
      this.groups.set(conversationId, next);
      this.emitter.emit('conversationUpdated', next);
    }
  }

  /** A command addressed to a conversation whose result we only check for errors. */
  private async command(
    method: string,
    conversationId: ConversationId,
    params: RpcParams,
  ): Promise<void> {
    this.assertAccount();
    try {
      await this.rpc.call(
        method,
        { ...targetParams(conversationId, this.selfAliases), ...params },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
  }

  private assertAccount(): void {
    if (!this.selfId)
      throw new SignalCliError('no-account', 'Not connected to a signal-cli account');
  }
}
