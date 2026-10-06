/**
 * ChatBackend over signal-cli, through a `SignalCliTransport`: the HTTP
 * daemon (`signal-cli daemon --http`, the default) or, in the desktop app,
 * a transport whose Rust side owns signal-cli (src/platform/tauri).
 *
 * - Commands go through `JsonRpcClient`.
 * - Incoming envelopes arrive on the transport's event subscription, are
 *   validated and normalised by pure functions, and are then applied *in
 *   order* through one promise queue — some need a daemon round-trip first
 *   (a group update is re-listed and diffed) and must not be overtaken by the
 *   message that follows them. After each event's work a `checkpoint` is
 *   emitted with the event's cursor; the resume position is persisted only
 *   when the sync engine acknowledges it (i.e. after the repository write),
 *   so a reload can cause re-delivery but never loss.
 * - signal-cli keeps no message history and has no DM list; the repository
 *   owns history, and `DirectPeers` remembers who we've talked to.
 * - Multi-account daemons: the account is sent as the `account` param and
 *   with the event subscription. Single-account daemons (`-a +X daemon`) have
 *   no `listAccounts`; we then send no account param and rely on the
 *   configured account for our own identity (see SelfIdentity).
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
  type Quote,
} from '@/core/domain';
import {
  Emitter,
  stripBidiControls,
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
import { AttachmentResolver, encodeOutgoing, type Thumbnailer } from './attachments';
import { Directory } from './directory';
import { describeError, SignalCliError } from './errors';
import { GroupChangeTracker } from './groupChanges';
import { isUuid, SelfIdentity } from './identity';
import { systemMessage } from './normalise/content';
import { describeGroupChange, timerSentence, toDirectConversation } from './normalise/directory';
import { normaliseReceive } from './normalise/envelope';
import type { AdapterEvent, NormaliseContext } from './normalise/types';
import {
  enrichSendError,
  messageParams,
  pinDurationParam,
  recipientFailures,
  targetParams,
} from './params';
import { DirectPeers } from './peers';
import { HttpTransport } from './httpTransport';
import { JsonRpcClient, type FetchLike, type RpcParams } from './rpc';
import type {
  EventStreamState,
  EventSubscription,
  SignalCliTransport,
  TransportEvent,
} from './transport';
import { isRecord, unknownValue } from './validate';
import {
  wireAccounts,
  wireFinishLink,
  wireSendResult,
  wireStartLink,
  type WireAccount,
} from './wire';

export interface SignalCliBackendOptions {
  /** HTTP daemon base URL (`/signal-cli` behind the Vite proxy); ignored with `transport`. */
  baseUrl: string;
  /** How to reach signal-cli; defaults to an `HttpTransport` on `baseUrl`. */
  transport?: SignalCliTransport;
  /**
   * Account (number or ACI). Multi-account daemons: preferred account (else
   * the first). Single-account daemons: *required* — it's our identity.
   */
  account?: string | null;
  fetch?: FetchLike;
  clock?: Clock;
  scheduler?: Scheduler;
  random?: () => number;
  /** Persists DM peers and the event resume position. */
  storage?: KeyValueStorage;
  /** Called with the account in use after connect/link, so settings can remember it. */
  onAccountSelected?: (account: string) => void;
  debug?: (message: string, detail?: unknown) => void;
  rpcTimeoutMs?: number;
  stream?: { initialDelayMs?: number; maxDelayMs?: number; idleTimeoutMs?: number };
  /** Makes previews of sent images (tests inject one; the default uses canvas). */
  thumbnailer?: Thumbnailer;
}

/** finishLink blocks until the phone scans the code. */
const LINK_TIMEOUT_MS = 10 * 60_000;
/** Quotes of messages sent this session, for edits whose caller omits them. */
const SENT_QUOTES_MAX = 500;

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

type GroupChanged = Extract<AdapterEvent, { kind: 'groupChanged' }>;

export class SignalCliBackend implements ChatBackend {
  readonly kind = 'signal-cli' as const;
  readonly link: LinkFlow;

  private readonly rpc: JsonRpcClient;
  private readonly emitter = new Emitter<BackendEvents>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly attachments: AttachmentResolver;
  private readonly directory: Directory;
  private readonly groupChanges = new GroupChangeTracker();
  private readonly sentQuotes = new Map<string, Quote>();
  private readonly debugLog: (message: string, detail?: unknown) => void;

  private status: ConnectionStatus = 'offline';
  private preferredAccount: string | null;
  private stream: EventSubscription | null = null;
  private readonly transport: SignalCliTransport;
  private connecting: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped on disconnect so queued work from an old session is dropped. */
  private session = 0;

  // Per-account state, set on connect.
  private identity = new SelfIdentity('');
  private multiAccount = true;
  private peers: DirectPeers | null = null;

  constructor(private readonly options: SignalCliBackendOptions) {
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.preferredAccount = options.account ?? null;
    this.debugLog =
      options.debug ??
      ((message, detail) => {
        console.debug(`[snowdrop] signal-cli: ${message}`, detail ?? '');
      });
    this.transport =
      options.transport ??
      new HttpTransport({
        baseUrl: options.baseUrl,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        scheduler: this.scheduler,
        ...(options.random ? { random: options.random } : {}),
        ...(options.stream ? { stream: options.stream } : {}),
      });
    this.rpc = new JsonRpcClient({
      transport: this.transport,
      ...(options.rpcTimeoutMs === undefined ? {} : { timeoutMs: options.rpcTimeoutMs }),
    });
    this.attachments = new AttachmentResolver({ rpc: this.rpc });
    this.directory = new Directory({
      rpc: this.rpc,
      now: () => this.clock.now(),
      scheduler: this.scheduler,
      identity: () => this.identity,
      peers: () => this.peers,
      debug: this.debugLog,
      onContactChanged: (contact) => {
        this.emitter.emit('contactUpdated', contact);
        if (this.peers?.has(contact.id)) {
          this.emitter.emit('conversationUpdated', this.directConversation(contact.id, 0));
        }
      },
    });
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
        if (!accountId) {
          throw new SignalCliError('invalid-response', 'finishLink returned no account');
        }
        this.preferredAccount = accountId;
        this.options.onAccountSelected?.(accountId);
        return { accountId };
      },
    };
  }

  private get selfId(): string {
    return this.identity.selfId;
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
      await this.rpc.check({ timeoutMs: this.transport.checkTimeoutMs ?? 5_000 });
      this.selectAccount(await this.discoverAccount());
      // Stream first: nothing sent to us while we load the directory is missed.
      this.openStream();
      // listGroups is local to the daemon and fast; listContacts may hit
      // Signal's servers for stale profiles, so it loads in the background.
      await this.directory.loadGroups(true);
      void this.directory.loadContacts(true);
    } catch (error) {
      await this.closeStream();
      this.setStatus('error');
      throw error;
    }
  }

  /**
   * Multi-account daemons list their accounts; a single-account daemon
   * answers METHOD_NOT_FOUND, and then the configured account is our identity.
   */
  private async discoverAccount(): Promise<WireAccount & { multi: boolean }> {
    let accounts: WireAccount[];
    try {
      accounts = await this.rpc.call('listAccounts', undefined, wireAccounts, { account: null });
    } catch (error) {
      if (!(error instanceof SignalCliError) || error.kind !== 'method-not-found') throw error;
      const configured = this.preferredAccount;
      if (!configured) {
        throw new SignalCliError(
          'account-required',
          'This signal-cli daemon serves a single account (started with -a). ' +
            'Enter that phone number (or ACI) in Snowdrop to continue.',
        );
      }
      return isUuid(configured)
        ? { aci: configured, number: undefined, multi: false }
        : { aci: undefined, number: configured, multi: false };
    }
    return { ...this.chooseAccount(accounts), multi: true };
  }

  async disconnect(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    this.session++;
    await this.closeStream();
    this.attachments.clear();
    this.groupChanges.clear();
    this.setStatus('offline');
  }

  private async closeStream(): Promise<void> {
    const stream = this.stream;
    this.stream = null;
    await stream?.stop();
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

  /** The account param in use (undefined for single-account daemons). */
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

  private selectAccount(account: WireAccount & { multi: boolean }): void {
    // Prefer the ACI: numberless accounts exist, and numbers can change.
    const id = account.aci ?? account.number ?? '';
    this.multiAccount = account.multi;
    this.rpc.account = account.multi ? id : undefined;
    this.identity = new SelfIdentity(id, [account.aci, account.number]);
    this.peers = new DirectPeers(this.options.storage, id);
    this.directory.reset();
    this.groupChanges.clear();
    if (id !== this.preferredAccount) this.options.onAccountSelected?.(id);
    this.preferredAccount = id;
  }

  /** Resume cursors are per transport kind (an SSE id means nothing to the desktop). */
  private cursorKey(): string {
    return `snowdrop.signal-cli.cursor.${this.transport.resumeScope}.${this.selfId}`;
  }

  private openStream(): void {
    const session = this.session;
    let resumeFrom = '';
    try {
      resumeFrom = this.options.storage?.getItem(this.cursorKey()) ?? '';
    } catch {
      // Storage unavailable: start from live events.
    }
    const stream = this.transport.subscribe({
      account: this.multiAccount ? this.selfId : null,
      resumeFrom,
      onEvent: (event) => {
        if (session === this.session) this.onTransportEvent(event);
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
        // Let a later connect() (the UI's "Retry") start over.
        this.stream = null;
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

  private onTransportEvent(event: TransportEvent): void {
    let events: AdapterEvent[] = [];
    if (event.type !== 'receive') {
      this.debugLog(`ignored event "${event.type}"`);
    } else {
      try {
        // SSE delivers text; IPC delivers parsed JSON.
        const payload: unknown =
          typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        this.learnSelf(payload);
        this.learnPeers(payload);
        events = normaliseReceive(payload, this.normaliseContext());
      } catch {
        // Never log the data itself: it can be (or embed) raw message text.
        this.debugLog('ignored non-JSON event data', `${String(event.data).length} chars`);
      }
    }
    // Even an ignored event advances the resume position (once acknowledged).
    this.enqueue(events, event.cursor || undefined);
  }

  /** Learns our other identifier from payloads (see SelfIdentity). */
  private learnSelf(payload: unknown): void {
    if (!isRecord(payload)) return;
    // The daemon labels every event with the account it belongs to.
    if (typeof payload.account === 'string') this.identity.add(payload.account);
    const envelope = payload.envelope;
    if (isRecord(envelope)) {
      const uuid = typeof envelope.sourceUuid === 'string' ? envelope.sourceUuid : undefined;
      const number = typeof envelope.sourceNumber === 'string' ? envelope.sourceNumber : undefined;
      this.identity.learnPair(uuid, number);
    }
  }

  /**
   * Learns peer number↔ACI aliases (DirectPeers) from any raw payload: every
   * wire shape names an address pair the same way — a `<prefix>Uuid` field
   * alongside a `<prefix>Number` one (`source*`, `destination*`,
   * `targetAuthor*`, `sender*`, the legacy quote `author*`, …) — so walking
   * the tree for that shape, rather than hand-listing every field, keeps
   * this learning everywhere an alias could show up.
   */
  private learnPeers(payload: unknown): void {
    if (!this.peers) return;
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (!isRecord(value) || seen.has(value)) return;
      seen.add(value);
      for (const key of Object.keys(value)) {
        if (!key.endsWith('Uuid')) continue;
        const uuid = value[key];
        const number = value[`${key.slice(0, -4)}Number`];
        if (typeof uuid === 'string' && typeof number === 'string') {
          this.peers?.learnPair(uuid, number);
        }
      }
      for (const v of Object.values(value)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(payload);
  }

  private normaliseContext(): NormaliseContext {
    return {
      selfId: this.selfId,
      selfAliases: this.identity.aliases,
      resolvePeer: (id) => this.peers?.resolve(id) ?? id,
      now: this.clock.now(),
      nameOf: (id) => this.directory.contact(id)?.name,
      debug: this.debugLog,
    };
  }

  /** Test hook: feeds a raw `receive` payload as if it came from the stream. */
  ingest(payload: unknown, cursor?: string): Promise<void> {
    this.learnSelf(payload);
    this.learnPeers(payload);
    this.enqueue(normaliseReceive(payload, this.normaliseContext()), cursor);
    return this.queue;
  }

  /** Resolves once every queued incoming event has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Persists the resume position once the sync engine has stored everything before it. */
  acknowledge(cursor: string): void {
    if (!this.selfId) return;
    try {
      this.options.storage?.setItem(this.cursorKey(), cursor);
    } catch {
      // Resume position is an optimisation only; the worst case is re-delivery.
    }
    // The desktop transport stops holding what's now stored.
    this.transport.acknowledge?.(cursor);
  }

  private enqueue(events: AdapterEvent[], cursor: string | undefined): void {
    const session = this.session;
    // Snapshot group state *now*: a directory reload before this update is
    // processed would otherwise already contain the new state.
    for (const event of events) {
      if (event.kind === 'groupChanged') {
        this.groupChanges.arrived(
          event.conversationId,
          this.directory.group(event.conversationId),
          event.actorId,
        );
      }
    }
    this.queue = this.queue.then(async () => {
      for (const event of events) {
        if (session !== this.session) return;
        try {
          await this.apply(event);
        } catch (error) {
          // Never log the error object itself: its message can embed payload data.
          this.debugLog(`failed to apply ${event.kind}`, describeError(error));
        }
      }
      if (cursor && session === this.session) this.emitter.emit('checkpoint', { cursor });
    });
  }

  private async apply(event: AdapterEvent): Promise<void> {
    switch (event.kind) {
      case 'message': {
        const message = event.payload;
        this.noteUnknown(message.conversationId, message.authorId);
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
        await this.directory.loadContacts(true);
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

  /** Stale-directory triggers: a stranger wrote, or a group we don't know. */
  private noteUnknown(conversationId: ConversationId, authorId: string): void {
    if (authorId !== this.selfId && !this.directory.hasContact(authorId)) {
      this.directory.scheduleContactsRefresh();
    }
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind === 'group' && !this.directory.group(conversationId)) {
      // The sync engine re-lists conversations for unknown ids; make that fresh.
      this.directory.invalidateGroups();
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
      this.directory.contact(peerId),
      this.directory.dmTimer(peerId),
      lastActivityAt,
    );
  }

  private applyTimer(conversationId: ConversationId, seconds: number): void {
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    if (parsed.kind === 'direct') {
      this.directory.setDmTimer(parsed.target, seconds);
      this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, 0));
      return;
    }
    const group = this.directory.group(conversationId);
    if (!group) return;
    const next = { ...group, expireTimerSec: seconds };
    this.directory.setGroup(next);
    this.emitter.emit('conversationUpdated', next);
  }

  private async applyGroupChange(event: GroupChanged): Promise<void> {
    const turn = this.groupChanges.take(event.conversationId);
    // A later update to the same group is queued: it will re-list and describe
    // the combined change (re-listing now would already show its state).
    if (!turn.last) return;
    const after = await this.directory.fetchGroup(event.groupId);
    if (!after) {
      // We left or were removed; keep history, just note it.
      this.emitSystem(event, 'You are no longer a member of this group.');
      return;
    }
    this.emitter.emit('conversationUpdated', after);
    const actorName = turn.actorId === null ? null : this.nameOf(turn.actorId);
    let lines: string[];
    if (!turn.before) {
      lines = [
        turn.actorId === this.selfId || actorName === null
          ? 'The group was updated.'
          : `${actorName} added you to the group.`,
      ];
    } else {
      lines = describeGroupChange(turn.before, after, actorName, (id) => this.nameOf(id));
      if (lines.length === 0) {
        lines = [actorName ? `${actorName} updated the group settings.` : 'The group was updated.'];
      }
    }
    this.emitSystem(event, lines.join(' '));
  }

  private emitSystem(event: GroupChanged, text: string): void {
    this.emitter.emit(
      'message',
      systemMessage(
        {
          conversationId: event.conversationId,
          authorId: event.actorId,
          receivedAt: this.clock.now(),
        },
        event.sentAt,
        text,
        'group',
      ),
    );
  }

  /** A local system line for a change we made from this device. */
  private emitOwnSystem(
    conversationId: ConversationId,
    sentAt: number,
    text: string,
    kind: string,
  ): void {
    this.emitter.emit(
      'message',
      systemMessage(
        { conversationId, authorId: this.selfId, receivedAt: this.clock.now() },
        sentAt,
        text,
        kind,
      ),
    );
  }

  // Stripped here since the result feeds plain-text system sentences
  // (describeGroupChange) that no later CSS isolation can protect.
  private nameOf(id: string): string {
    if (id === this.selfId) return 'You';
    return stripBidiControls(this.directory.contact(id)?.name ?? id);
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  async getSelf(): Promise<Contact> {
    this.assertAccount();
    await this.directory.loadContacts();
    const known = this.directory.contact(this.selfId);
    const self: Contact = known
      ? { ...known, isSelf: true }
      : {
          id: this.selfId,
          name: this.identity.number ?? 'You',
          color: colorForId(this.selfId),
          isSelf: true,
        };
    if (this.identity.number && !self.number) self.number = this.identity.number;
    return self;
  }

  async listContacts(): Promise<Contact[]> {
    this.assertAccount();
    const contacts = await this.directory.loadContacts();
    return contacts.filter((c) => c.id !== this.selfId);
  }

  async listConversations(): Promise<Conversation[]> {
    this.assertAccount();
    const groups = await this.directory.loadGroups();
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
    const target = targetParams(input.conversationId, this.identity.aliases);
    const stamp = this.clock.now().toString(36);
    const encoded = await Promise.all(
      (input.attachments ?? []).map((file, i) =>
        encodeOutgoing(file, `local:${stamp}:${i}`, this.options.thumbnailer),
      ),
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
    if (input.quote) this.rememberQuote(input.conversationId, result.timestamp, input.quote);
    const failures = recipientFailures(result);
    this.notePeer(input.conversationId, this.clock.now());
    const out: SendResult = { sentAt: result.timestamp };
    if (encoded.length > 0) out.attachments = encoded.map((e) => e.attachment);
    if (failures.length > 0) out.recipientFailures = failures;
    return out;
  }

  private rememberQuote(conversationId: ConversationId, sentAt: number, quote: Quote): void {
    this.sentQuotes.set(`${conversationId}|${sentAt}`, quote);
    if (this.sentQuotes.size > SENT_QUOTES_MAX) {
      const oldest = this.sentQuotes.keys().next().value;
      if (oldest !== undefined) this.sentQuotes.delete(oldest);
    }
  }

  /**
   * signal-cli builds the edit's *entire* data message from these params, so
   * the original's quote is re-sent (from the input, or remembered from this
   * session). Attachments can't be re-sent cheaply; Signal clients keep the
   * original's attachments for an edit, but this is unverified for signal-cli.
   */
  async edit(input: EditInput): Promise<{ sentAt: number }> {
    this.assertAccount();
    const quote =
      input.quote ?? this.sentQuotes.get(`${input.conversationId}|${input.targetSentAt}`);
    const params = {
      ...targetParams(input.conversationId, this.identity.aliases),
      ...messageParams({
        body: input.body,
        ranges: input.ranges,
        ...(quote ? { quote } : {}),
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
      params.pinDuration = pinDurationParam(input.durationSec);
      await this.command('sendPinMessage', input.conversationId, params);
    } else {
      await this.command('sendUnpinMessage', input.conversationId, params);
    }
  }

  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    this.assertAccount();
    const target = targetParams(conversationId, this.identity.aliases);
    if ('noteToSelf' in target) return;
    await this.rpc.call('sendTyping', { ...target, stop: !typing }, ignoreResult);
  }

  async markRead(_conversationId: ConversationId, messages: MessageRef[]): Promise<void> {
    this.assertAccount();
    // Receipts are addressed to each message's author, not to the conversation.
    const byAuthor = new Map<string, number[]>();
    for (const m of messages) {
      if (this.identity.isSelf(m.authorId) || m.authorId === this.selfId) continue;
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

  /**
   * Group: `updateGroup`. DM timer: `updateContact --expiration`, which also
   * un-hides a contact you had hidden on your phone (signal-cli behaviour).
   * Our other devices learn the change from Signal, but nothing echoes it to
   * *this* client, so the system line is written locally.
   */
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
      const result = await this.rpc.call(
        'updateContact',
        { recipient: parsed.target, expiration: patch.expireTimerSec },
        ignoreResult,
      );
      const dm = directConversationId(parsed.target);
      this.applyTimer(dm, patch.expireTimerSec);
      this.emitOwnSystem(
        dm,
        this.resultTimestamp(result),
        timerSentence('You', patch.expireTimerSec),
        'timer',
      );
      return;
    }
    const params: RpcParams = { groupId: parsed.target };
    if (patch.title !== undefined) params.name = patch.title;
    if (patch.description !== undefined) params.description = patch.description;
    if (patch.expireTimerSec !== undefined) params.expiration = patch.expireTimerSec;
    const result = await this.rpc.call('updateGroup', params, ignoreResult);
    const current = this.directory.group(conversationId);
    if (!current) return;
    const next: Conversation = { ...current };
    if (patch.title !== undefined) next.title = patch.title;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.expireTimerSec !== undefined) next.expireTimerSec = patch.expireTimerSec;
    this.directory.setGroup(next);
    this.emitter.emit('conversationUpdated', next);
    const lines = describeGroupChange(current, next, 'You', (id) => this.nameOf(id));
    if (lines.length > 0) {
      this.emitOwnSystem(conversationId, this.resultTimestamp(result), lines.join(' '), 'group');
    }
  }

  /** The `timestamp` of a send-like result, else now (identity of a local system line). */
  private resultTimestamp(result: unknown): number {
    return isRecord(result) && typeof result.timestamp === 'number'
      ? result.timestamp
      : this.clock.now();
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
        { ...targetParams(conversationId, this.identity.aliases), ...params },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
  }

  private assertAccount(): void {
    if (!this.selfId) {
      throw new SignalCliError('no-account', 'Not connected to a signal-cli account');
    }
  }
}
