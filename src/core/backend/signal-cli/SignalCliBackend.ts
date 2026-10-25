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
 * - The optional Snowdrop history patch supplies phone history; stock
 *   signal-cli has none. The repository retains received messages, and
 *   `DirectPeers` remembers who we've talked to.
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
  type Message,
  type Quote,
  type RecipientQuery,
  type StickerContent,
} from '@/core/domain';
import {
  createLogger,
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
  HistoryPage,
  HistoryQuery,
  HistoryReadRef,
  HistoryReadState,
  LinkFlow,
  MarkReadOptions,
  ReadSummary,
  MessageRef,
  MessageRequestResponse,
  PhonePrivacyPatch,
  PhonePrivacySettings,
  PinInput,
  ProfileUpdate,
  ReactInput,
  RecipientLookup,
  SendInput,
  SendResult,
  StickerPackDetails,
  StickerPackInfo,
  StickerPackSticker,
} from '../types';
import {
  AttachmentResolver,
  encodeOutgoing,
  encodeOutgoingPreview,
  stickerCacheId,
  type Thumbnailer,
} from './attachments';
import {
  supportsAttachmentBackfill as detectAttachmentBackfillSupport,
  supportsCustomEmojiDelivery as detectCustomEmojiSupport,
  supportsHistoryStickerPack as detectHistoryStickerPackSupport,
  supportsPhonePrivacy as detectPhonePrivacySupport,
  supportsReadSync as detectReadSyncSupport,
  supportsCatchingUpSignal as detectCatchingUpSignalSupport,
  supportsStickerPackInstall as detectStickerPackInstallSupport,
} from './capabilities';
import { Directory } from './directory';
import { describeError, isSignalCliError, SignalCliError } from './errors';
import { GroupChangeTracker } from './groupChanges';
import { HistoryArchive } from './history/archive';
import { timestamp } from './history/wire';
import { isUuid, SelfIdentity } from './identity';
import { systemMessage } from './normalise/content';
import { describeGroupChange, timerSentence, toDirectConversation } from './normalise/directory';
import { normaliseReceive } from './normalise/envelope';
import type { AdapterEvent, NormaliseContext } from './normalise/types';
import {
  enrichSendError,
  messageParams,
  pinDurationParam,
  profileParams,
  recipientFailures,
  stickerParam,
  summariseReadReplies,
  targetParams,
} from './params';
import { DirectPeers } from './peers';
import { cursorStorageKey } from './storageKeys';
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
  wirePhonePrivacy,
  wireStartLink,
  wireStickerPacks,
  wireUserStatuses,
  wireVersion,
  type WireAccount,
  type WireStickerPack,
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

/** Allow time to scan the code and transfer history after provisioning. */
const LINK_TIMEOUT_MS = 15 * 60_000;
/** Quotes of messages sent this session, for edits whose caller omits them. */
const SENT_QUOTES_MAX = 500;

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

const ATTACHMENT_BACKFILL_STATUSES = new Set(['pending', 'ready', 'failed']);

/**
 * Parses the `attachmentBackfill` SSE event's data (patches/signal-cli's
 * `{targetAuthor, targetTimestamp, status, attachmentIds}`) into the
 * `BackendEvents['attachmentBackfill']` shape. Lenient like `learnSelf`/
 * `learnPeers`: a malformed event is dropped rather than crashing the
 * stream, since it's advisory (the attachment just stays however it was).
 */
function parseAttachmentBackfillEvent(
  payload: unknown,
): BackendEvents['attachmentBackfill'] | undefined {
  if (!isRecord(payload)) return undefined;
  const { targetAuthor, targetTimestamp, status, attachmentIds } = payload;
  if (typeof targetAuthor !== 'string') return undefined;
  if (typeof targetTimestamp !== 'number' && typeof targetTimestamp !== 'string') return undefined;
  if (typeof status !== 'string' || !ATTACHMENT_BACKFILL_STATUSES.has(status)) return undefined;
  if (!Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === 'string'))
    return undefined;
  return {
    targetAuthorId: targetAuthor,
    targetSentAt: Number(targetTimestamp),
    status: status as 'pending' | 'ready' | 'failed',
    attachmentIds,
  };
}

const log = createLogger('signal-cli');

/**
 * Right after linking, signal-cli may still be receiving the groups sync it
 * requested from the phone at link time; these are the offsets (from a
 * successful connect) at which the group list is force-re-listed to pick it
 * up, without waiting for the long cache TTL or a message from an unknown
 * group. Each check stops the remaining ones once the group count is no
 * longer changing (see scheduleGroupBackoff).
 */
const GROUP_BACKOFF_DELAYS_MS = [5_000, 20_000, 60_000, 180_000];

/**
 * Backoff before giving up on a previously-linked account signal-cli failed
 * to load this time (see `resolveAccount`): a restart + recheck at each
 * delay, then `account-unavailable` — the caller (SyncService) keeps
 * retrying every minute after that.
 */
const ACCOUNT_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

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
  private history: Promise<HistoryArchive | null> | null = null;
  private historyAbort = new AbortController();
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
  /** Whether the connected daemon can deliver custom emoji (see capabilities.ts). */
  private customEmojiSupported = false;
  /** Whether the connected daemon implements attachment backfill (see capabilities.ts). */
  private attachmentBackfillSupported = false;
  /** Whether the connected daemon can register a history sticker's pack key (see capabilities.ts). */
  private historyStickerPackSupported = false;
  /** Whether the connected daemon can install a known sticker pack by id (see capabilities.ts). */
  private stickerPackInstallSupported = false;
  /** Whether the connected daemon reports the phone's privacy settings (see capabilities.ts). */
  private phonePrivacySupported = false;
  private readSyncSupported = false;
  private catchingUpSignalSupported = false;
  /** Installed packs whose download `listStickerPacks` already started this session. */
  private readonly stickerPacksFetchTried = new Set<string>();
  /** listConversations logs its counts once per backend, not on every refresh. */
  private listingLogged = false;

  constructor(private readonly options: SignalCliBackendOptions) {
    this.clock = options.clock ?? systemClock;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.preferredAccount = options.account ?? null;
    this.debugLog =
      options.debug ??
      ((message, detail) => {
        log.debug(message, detail);
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
        // Only announce a conversation update for a contact already listed
        // (recorded local activity); a refreshed profile must not promote a
        // contact we've never messaged into a conversation on its own (see
        // listConversations).
        if (this.peers?.has(contact.id)) {
          this.emitter.emit('conversationUpdated', this.directConversation(contact.id, 0));
        }
      },
      onGroupChanged: (conv) => {
        this.emitter.emit('conversationUpdated', conv);
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
        return {
          accountId,
          ...(result.historyTransfer === 'FAILED'
            ? {
                historyWarning:
                  'Your device is linked, but message history could not be imported. You can use Snowdrop now. Retrying history transfer requires unlinking this device on your phone and linking it again.',
              }
            : {}),
        };
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
      const version = await this.probeVersion();
      this.customEmojiSupported = detectCustomEmojiSupport(version);
      this.attachmentBackfillSupported = detectAttachmentBackfillSupport(version);
      this.historyStickerPackSupported = detectHistoryStickerPackSupport(version);
      this.stickerPackInstallSupported = detectStickerPackInstallSupport(version);
      this.phonePrivacySupported = detectPhonePrivacySupport(version);
      this.readSyncSupported = detectReadSyncSupport(version);
      this.catchingUpSignalSupported = detectCatchingUpSignalSupport(version);
      this.selectAccount(await this.discoverAccount());
      // Stream first: nothing sent to us while we load the directory is missed.
      this.openStream();
      // listGroups is local to the daemon and fast; listContacts may hit
      // Signal's servers for stale profiles, so it loads in the background.
      await this.directory.loadGroups(true);
      void this.directory.loadContacts(true);
      this.scheduleGroupBackoff();
    } catch (error) {
      await this.closeStream();
      this.setStatus('error');
      throw error;
    }
  }

  /**
   * `version` takes no account and never fails a connect: an older daemon
   * that somehow rejects it just means no capabilities it gates (today,
   * only custom emoji) are offered.
   */
  private async probeVersion(): Promise<string | undefined> {
    try {
      const { version } = await this.rpc.call('version', undefined, wireVersion, {
        account: null,
      });
      return version;
    } catch {
      return undefined;
    }
  }

  /** Whether the connected signal-cli build can deliver custom emoji images (see capabilities.ts). */
  supportsCustomEmojiDelivery(): boolean {
    return this.customEmojiSupported;
  }

  /** Whether the connected signal-cli build implements attachment backfill (see capabilities.ts). */
  supportsAttachmentBackfill(): boolean {
    return this.attachmentBackfillSupported;
  }

  /** Whether the connected signal-cli build can install a known sticker pack (see capabilities.ts). */
  supportsStickerPackInstall(): boolean {
    return this.stickerPackInstallSupported;
  }

  /** Whether the connected signal-cli build reports the phone's privacy settings (see capabilities.ts). */
  supportsPhonePrivacy(): boolean {
    return this.phonePrivacySupported;
  }

  /** Whether `markRead` can sync-only (see capabilities.ts, `supportsReadSync`). */
  supportsReadSync(): boolean {
    return this.readSyncSupported;
  }

  /** Whether the build tells us when a drain starts (see capabilities.ts, `supportsCatchingUpSignal`). */
  supportsCatchingUpSignal(): boolean {
    return this.catchingUpSignalSupported;
  }

  /** See `ChatBackend.readPhonePrivacy`: the stored configuration the phone synced to us. */
  async readPhonePrivacy(): Promise<PhonePrivacySettings> {
    this.assertAccount();
    if (!this.phonePrivacySupported)
      throw new SignalCliError(
        'user',
        "This signal-cli can't report your phone's privacy settings.",
      );
    const wire = await this.rpc.call('getConfiguration', undefined, wirePhonePrivacy);
    return {
      readReceipts: wire.readReceipts ?? null,
      typingIndicators: wire.typingIndicators ?? null,
      linkPreviews: wire.linkPreviews ?? null,
      unidentifiedDeliveryIndicators: wire.unidentifiedDeliveryIndicators ?? null,
    };
  }

  /** See `ChatBackend.updatePhonePrivacy`: signal-cli stores it and syncs it to the phone. */
  async updatePhonePrivacy(patch: PhonePrivacyPatch): Promise<void> {
    this.assertAccount();
    if (!this.phonePrivacySupported)
      throw new SignalCliError(
        'user',
        "This signal-cli can't change your phone's privacy settings.",
      );
    const params: RpcParams = {};
    if (patch.readReceipts !== undefined) params.readReceipts = patch.readReceipts;
    if (patch.typingIndicators !== undefined) params.typingIndicators = patch.typingIndicators;
    if (patch.linkPreviews !== undefined) params.linkPreviews = patch.linkPreviews;
    if (Object.keys(params).length === 0) return;
    await this.rpc.call('updateConfiguration', params, ignoreResult);
  }

  /**
   * See `ChatBackend.updateProfile`: signal-cli uploads the profile and tells
   * the phone to refetch it. Contacts are re-listed at once so `self` reflects
   * what signal-cli now stores.
   */
  async updateProfile(update: ProfileUpdate): Promise<Contact> {
    this.assertAccount();
    await this.rpc.call('updateProfile', profileParams(update), ignoreResult);
    await this.directory.loadContacts(true);
    return this.getSelf();
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
    return { ...(await this.resolveAccount(accounts)), multi: true };
  }

  /**
   * Force-re-lists groups at GROUP_BACKOFF_DELAYS_MS after a successful
   * connect, so the groups sync landing shortly after linking shows up
   * without waiting for the long cache TTL. Stops scheduling further checks
   * once one finds the group count unchanged (dedupes with `groupsLoading`
   * via the ordinary `loadGroups` path, so this never doubles up a listGroups
   * already in flight).
   */
  private scheduleGroupBackoff(): void {
    const session = this.session;
    let lastCount = this.directory.allGroups().length;
    let stopped = false;
    for (const delayMs of GROUP_BACKOFF_DELAYS_MS) {
      this.scheduler.setTimeout(() => {
        if (stopped || session !== this.session) return;
        void this.directory.loadGroups(true).then(() => {
          if (stopped || session !== this.session) return;
          const count = this.directory.allGroups().length;
          // Still none: the phone's sync usually hasn't landed yet, so keep
          // checking. Once groups exist and the count settles, stop early.
          if (count > 0 && count === lastCount) {
            stopped = true;
            return;
          }
          lastCount = count;
        });
      }, delayMs);
    }
  }

  async disconnect(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    this.session++;
    this.historyAbort.abort();
    this.history = null;
    await this.closeStream();
    this.attachments.clear();
    this.groupChanges.clear();
    this.customEmojiSupported = false;
    this.attachmentBackfillSupported = false;
    this.historyStickerPackSupported = false;
    this.stickerPackInstallSupported = false;
    this.phonePrivacySupported = false;
    this.readSyncSupported = false;
    this.catchingUpSignalSupported = false;
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

  /** The usable account among `accounts` matching `preferredAccount`, or the first if none set. */
  private pickAccount(accounts: WireAccount[]): WireAccount | undefined {
    const usable = accounts.filter((a) => a.aci ?? a.number);
    const preferred = this.preferredAccount;
    const match = preferred
      ? usable.find((a) => a.aci === preferred || a.number === preferred)
      : undefined;
    const chosen = match ?? usable[0];
    if (chosen && preferred && !match)
      this.debugLog(`account ${preferred} not found; using the first one`);
    return chosen;
  }

  /**
   * Picks the account `listAccounts` should serve, retrying if a
   * previously-linked account (`preferredAccount`) is missing: signal-cli's
   * MultiAccountManager builds itself once at startup and drops an account
   * that fails its check against the server right then (a network hiccup,
   * commonly), never retrying on its own. Only a fresh process gives it
   * another chance — `transport.restart` — so this restarts and rechecks
   * with a bounded backoff before giving up as `account-unavailable` (never
   * `no-account`: that's reserved for a device that has truly never linked,
   * so it's the only case that may route to the — destructive — link flow).
   */
  private async resolveAccount(initial: WireAccount[]): Promise<WireAccount> {
    let accounts = initial;
    for (let attempt = 0; ; attempt++) {
      const chosen = this.pickAccount(accounts);
      if (chosen) return chosen;
      if (!this.preferredAccount) {
        throw new SignalCliError(
          'no-account',
          'signal-cli has no account yet. Link this device to your phone to continue.',
        );
      }
      const delayMs = ACCOUNT_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) {
        throw new SignalCliError(
          'account-unavailable',
          "signal-cli couldn't load the linked account. This is usually transient; Snowdrop will keep retrying.",
        );
      }
      const session = this.session;
      await this.delay(delayMs);
      if (session !== this.session)
        throw new SignalCliError('aborted', 'Disconnected while reconnecting');
      try {
        await this.transport.restart?.();
      } catch (error) {
        this.debugLog('restarting signal-cli to recover the account failed', error);
      }
      if (session !== this.session)
        throw new SignalCliError('aborted', 'Disconnected while reconnecting');
      accounts = await this.rpc
        .call('listAccounts', undefined, wireAccounts, { account: null })
        .catch(() => [] as WireAccount[]);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.scheduler.setTimeout(resolve, ms);
    });
  }

  private selectAccount(account: WireAccount & { multi: boolean }): void {
    // Prefer the ACI: numberless accounts exist, and numbers can change.
    const id = account.aci ?? account.number ?? '';
    this.multiAccount = account.multi;
    this.rpc.account = account.multi ? id : undefined;
    this.identity = new SelfIdentity(id, [account.aci, account.number]);
    this.peers = new DirectPeers(this.options.storage, id);
    this.directory.reset();
    this.historyAbort.abort();
    this.historyAbort = new AbortController();
    this.history = null;
    this.groupChanges.clear();
    if (id !== this.preferredAccount) this.options.onAccountSelected?.(id);
    this.preferredAccount = id;
  }

  /** Resume cursors are per transport kind (an SSE id means nothing to the desktop). */
  private cursorKey(): string {
    return cursorStorageKey(this.transport.resumeScope, this.selfId);
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
    if (event.type === 'receiveCatchingUp') {
      // Patched signal-cli only (patches/signal-cli/0025): the receive
      // websocket (re)connected and the server is delivering what queued up.
      // No envelope; the receiveCaughtUp that follows ends it.
      this.emitter.emit('catchingUp', undefined);
    } else if (event.type === 'receiveCaughtUp') {
      // Patched signal-cli only (patches/signal-cli/0012): the receive loop
      // drained the server's queue. No envelope; nothing to normalise.
      this.emitter.emit('caughtUp', undefined);
    } else if (event.type === 'receiveConfigurationChanged') {
      // Patched signal-cli only (patches/signal-cli/0022): the privacy settings
      // changed; no values travel with it, the service re-reads them.
      this.emitter.emit('phonePrivacyChanged', undefined);
    } else if (event.type === 'attachmentBackfill') {
      // Patched signal-cli only (patches/signal-cli/0016): our primary
      // answered a requestAttachmentBackfill call.
      const payload: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      const backfill = parseAttachmentBackfillEvent(payload);
      if (backfill) this.emitter.emit('attachmentBackfill', backfill);
      else this.debugLog('ignored malformed attachmentBackfill event');
    } else if (event.type !== 'receive') {
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
        // Only a real message lists a DM or bumps its activity (see
        // notePeer): a system line (a decrypt failure, a timer change) is
        // still stored and shown in an already-listed conversation, but must
        // never create or raise one on its own.
        if (message.kind === 'normal') this.notePeer(message.conversationId, message.sentAt);
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
        // Contacts and groups syncs often arrive together (and either can
        // land first right after linking), so a sync of either kind
        // refreshes both, bypassing the cache TTL.
        await Promise.all([this.directory.loadContacts(true), this.directory.loadGroups(true)]);
        return;
      case 'directoryHint':
        this.directory.scheduleContactsRefresh();
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

  /**
   * Remembers a DM peer; announces the conversation the first time we see
   * it. `at` is always a real message's own `sentAt` (never a system line's,
   * and never this device's local receive time) — see the `kind === 'normal'`
   * guard at both call sites, and `chatLatestMessageAt`'s doc for why
   * `sentAt` rather than receive time keeps a replayed backlog in the
   * phone's order.
   */
  private notePeer(conversationId: ConversationId, at: number): void {
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind !== 'direct' || !this.peers) return;
    if (this.peers.touch(parsed.target, at)) {
      this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, at));
    }
  }

  private directConversation(rawPeerId: string, lastActivityAt: number): Conversation {
    // Always the canonical form, so a conversation is never announced under a folded alias.
    const peerId = this.peers?.resolve(rawPeerId) ?? rawPeerId;
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
      // Same rule as onContactChanged: a timer change alone (no content of
      // its own — see normalise/envelope.ts's isExpirationUpdate branch)
      // must not announce, and so list, a DM we've never otherwise talked
      // to. Once a real message does arrive, directConversation reads the
      // timer set here fresh, so nothing is lost by not announcing it now.
      if (this.peers?.has(parsed.target)) {
        this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, 0));
      }
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
    const history = await this.loadHistory();
    return [
      ...new Map(
        [...(history?.directory.contacts() ?? []), ...contacts].map((contact) => [
          contact.id,
          contact,
        ]),
      ).values(),
    ].filter((contact) => contact.id !== this.selfId);
  }

  /**
   * Matches the phone: a direct conversation (Note to Self included, no
   * special-casing) is listed only if it has at least one real message —
   * `this.peers` (durably persisted, see peers.ts) for local/live activity,
   * or the history archive for an imported one. A group we're a current
   * member of is always listed (`Directory.loadGroups` already filters to
   * `isMember`), same as the phone showing a group before anyone writes.
   * `lastActivityAt` is the newest real message's own timestamp, live or
   * from history, whichever is greater — never a system line's (see
   * `chatLatestMessageAt`'s doc for the live/history field choice).
   *
   * A peer-sourced DM this still lists purely because of a stale persisted
   * touch (from a since-fixed bug that let a system line count) isn't
   * something this method alone can tell apart from a real one: the
   * repository that would prove it lives on the SyncService side, which
   * filters those back out — see its `dropStaleDirects`.
   *
   * Signal's profileSharing ("you've chatted, or accepted their message
   * request") is deliberately *not* used to list an empty DM: it fires for
   * lots of people with zero shared history (group co-members, contacts
   * synced from storage service), which is exactly the noise this is
   * fixing.
   */
  async listConversations(): Promise<Conversation[]> {
    this.assertAccount();
    const [groups] = await Promise.all([
      this.directory.loadGroups(),
      this.directory.loadContacts(), // populates the cache directConversation's names read from.
    ]);
    const dms = new Map<string, Conversation>();
    for (const [peer, at] of this.peers?.entries() ?? []) {
      dms.set(peer, this.directConversation(peer, at));
    }
    const history = await this.loadHistory();
    const live = new Set([...groups, ...dms.values()].map((conversation) => conversation.id));
    // Per-id: the archive's newest real message (for ordering *and*
    // existence) and its archived-on-the-phone hint — looked up for every
    // history conversation, including ones a live source also lists (its
    // own activity still has to be maxed against history below), and kept
    // in these side maps since a live conversation is never taken from
    // `merged` itself (see the final loop).
    const historyLatestAt = new Map<string, number>();
    const historyArchivedIds = new Set<string>();
    const merged = new Map<string, Conversation>();
    let historyOnlyExcluded = 0;
    if (history) {
      const checked = await Promise.all(
        history.directory.conversations().map(async (conversation) => {
          const chatId = history.directory.chatId(conversation.id);
          const at = chatId !== undefined ? await history.chatLatestMessageAt(chatId) : undefined;
          if (at !== undefined) historyLatestAt.set(conversation.id, at);
          if (conversation.historyArchived) historyArchivedIds.add(conversation.id);
          if (live.has(conversation.id)) return null;
          // A history-only chat (no live membership/activity) is listed
          // only if the archive actually has a real message for it.
          if (at === undefined) {
            historyOnlyExcluded++;
            return null;
          }
          return {
            ...conversation,
            lastActivityAt: at,
            historyHasMessages: true,
          };
        }),
      );
      for (const conversation of checked) {
        if (conversation) merged.set(conversation.id, conversation);
      }
    }
    // Live sources always win on conflict: take the max of their own
    // activity with whatever the archive knows for the same id (a real
    // message that predates this session's peers/group cache, or simply an
    // older one than the live value already carries), and keep the
    // archived-on-the-phone hint a history entry may have carried (see
    // Conversation.historyArchived) — a group/DM can be both currently
    // active and archived on the phone.
    for (const conversation of [...groups, ...dms.values()]) {
      const historyAt = historyLatestAt.get(conversation.id) ?? 0;
      merged.set(conversation.id, {
        ...conversation,
        lastActivityAt: Math.max(conversation.lastActivityAt, historyAt),
        ...(historyArchivedIds.has(conversation.id) ? { historyArchived: true } : {}),
        ...(historyLatestAt.has(conversation.id) ? { historyHasMessages: true } : {}),
      });
    }
    if (!this.listingLogged) {
      // Counts only (never names or ids): enough to tell which rule listed
      // (or, for history, dropped) what. A peer-sourced DM with no real
      // message anywhere (a stale entry persisted by a since-fixed bug) is
      // excluded on the SyncService side instead — it alone has the local
      // repository; see its own one-time log.
      this.listingLogged = true;
      log.info('conversations listed', {
        groups: groups.length,
        directWithActivity: dms.size,
        fromHistory: merged.size - live.size,
        historyOnlyExcluded,
      });
    }
    return [...merged.values()];
  }

  private loadHistory(): Promise<HistoryArchive | null> {
    if (this.history) return this.history;
    const signal = this.historyAbort.signal;
    const pending = (async () => {
      await this.directory.loadContacts();
      if (signal.aborted) throw new SignalCliError('aborted', 'History session ended');
      const identity = this.identity;
      const peers = this.peers;
      return HistoryArchive.open(
        this.rpc,
        identity.selfId,
        (id) => identity.resolve(peers?.resolve(id) ?? id),
        signal,
      );
    })();
    this.history = pending;
    void pending.catch(() => {
      if (this.history === pending) this.history = null;
    });
    return pending;
  }

  async historyHasOutgoing(conversationId: ConversationId): Promise<boolean> {
    this.assertAccount();
    const archive = await this.loadHistory();
    const chatId = archive?.directory.chatId(conversationId);
    return archive !== null && chatId !== undefined ? archive.chatHasOutgoing(chatId) : false;
  }

  async fetchHistory(conversationId: ConversationId, query: HistoryQuery): Promise<HistoryPage> {
    this.assertAccount();
    const archive = await this.loadHistory();
    return archive
      ? archive.fetchHistory(conversationId, query, this.clock.now())
      : { messages: [], hasMoreBefore: false };
  }

  async remapHistoryMessages(messages: readonly Message[]): Promise<Message[]> {
    this.assertAccount();
    const archive = await this.loadHistory();
    return archive ? archive.remap(messages, this.clock.now()) : [];
  }

  async getHistoryArchiveId(): Promise<string | null> {
    this.assertAccount();
    const archive = await this.loadHistory();
    return archive?.archiveId ?? null;
  }

  async readHistory(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyReadStates(messages, true);
  }

  async getHistoryReadState(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyReadStates(messages, false);
  }

  private async historyReadStates(
    messages: readonly HistoryReadRef[],
    markRead: boolean,
  ): Promise<HistoryReadState[]> {
    this.assertAccount();
    const archive = await this.loadHistory();
    if (!archive) throw new SignalCliError('io', 'Imported history is unavailable');
    const prefix = `${archive.archiveId}:`;
    const references = new Map(
      messages.map((message) => {
        if (!message.cursor.startsWith(prefix))
          throw new SignalCliError('io', 'History archive changed');
        return [message.cursor.slice(prefix.length), message.id];
      }),
    );
    const states = await archive.read([...references.keys()], markRead);
    return states.map((state) => {
      const id = references.get(state.cursor);
      if (!id)
        throw new SignalCliError('invalid-response', 'History read returned an unknown cursor');
      return {
        id,
        ...(state.expiresAt === undefined ? {} : { expiresAt: timestamp(state.expiresAt) }),
        unavailable: state.unavailable,
      };
    });
  }

  async resolveAttachmentUrl(
    _conversationId: ConversationId,
    attachment: Attachment,
    options?: { forceRefresh?: boolean },
  ): Promise<string> {
    this.assertAccount();
    return this.attachments.resolve(attachment, {}, options);
  }

  async readAttachmentBlob(
    _conversationId: ConversationId,
    attachment: Attachment,
    options?: { maxBytes?: number },
  ): Promise<Blob> {
    this.assertAccount();
    return this.attachments.readBlob(attachment, {}, options?.maxBytes);
  }

  retainAttachmentUrl(attachment: Attachment): void {
    this.attachments.retain(attachment.id);
  }

  releaseAttachmentUrl(attachment: Attachment): void {
    this.attachments.release(attachment.id);
  }

  /**
   * See `ChatBackend.resolveStickerUrl`. When the pack isn't known locally —
   * typical for a sticker that only ever arrived through an imported
   * history archive — and this build can register one (patches/signal-cli's
   * "0019"), registers it from the backup's own copy of the key first.
   * Registration asks signal-cli to resolve `backupAttachment.id` itself
   * (the same opaque history id `getAttachment` already accepts); the key
   * never crosses this RPC boundary.
   *
   * Then retries `getSticker`, bounded: a daemon without patch 0020
   * (< history.16) downloads a not-yet-fetched pack on the first call that
   * needs it and still fails that call, so one more call (two after a fresh
   * registration, whose first `getSticker` was the one that failed) is what
   * actually works there. A current daemon just succeeds on the first retry.
   * Failures log the stage and error kind/code only.
   */
  async resolveStickerUrl(
    sticker: StickerContent,
    options?: { forceRefresh?: boolean },
  ): Promise<string> {
    this.assertAccount();
    let first: unknown;
    try {
      return await this.attachments.resolveSticker(sticker, options);
    } catch (error) {
      first = error;
    }
    let retries = 1;
    let registration: 'unsupported' | 'no-backup' | 'ok' | 'failed' = !this
      .historyStickerPackSupported
      ? 'unsupported'
      : sticker.backupAttachment
        ? 'ok'
        : 'no-backup';
    if (this.historyStickerPackSupported && sticker.backupAttachment) {
      try {
        await this.rpc.call(
          'registerHistoryStickerPack',
          { id: sticker.backupAttachment.id },
          ignoreResult,
        );
        retries = 2;
      } catch (error) {
        const { kind, code } = error as { kind?: unknown; code?: unknown };
        log.warn('sticker pack registration failed', {
          ...(typeof kind === 'string' ? { kind } : {}),
          ...(typeof code === 'number' ? { code } : {}),
        });
        registration = 'failed';
        logStickerFailure(registration, first, first);
        throw first; // The original error names the real cause.
      }
    }
    let last: unknown = first;
    for (let i = 0; i < retries; i++) {
      try {
        return await this.attachments.resolveSticker(sticker, options);
      } catch (error) {
        // Keep the first error to throw; it's the one that names the real cause.
        last = error;
      }
    }
    logStickerFailure(registration, first, last);
    throw first;
  }

  /**
   * See `ChatBackend.listStickerPacks`. `listStickerPacks` lists every pack
   * the account knows — including history-registered ones that aren't
   * installed (patch 0019), which are left out — and an installed pack whose
   * files were never downloaded (it arrived through storage sync) lists with
   * no stickers. `getSticker` downloads a whole pack as a side effect (the
   * same local download `resolveStickerUrl` relies on; no install, no sync
   * to the phone), so one call per such pack and a second listing fill them
   * in. The result of that call is ignored: a daemon without patch 0020
   * downloads the pack and still throws on the first one.
   */
  async listStickerPacks(): Promise<StickerPackInfo[]> {
    this.assertAccount();
    const list = (): Promise<WireStickerPack[]> =>
      this.rpc.call('listStickerPacks', {}, wireStickerPacks);
    let packs = (await list()).filter((p) => p.installed);
    // Each not-yet-downloaded pack is fetched once per session: one that
    // can't be (removed from the CDN, offline) mustn't stall every open.
    const unfetched = packs.filter(
      (p) => p.stickers.length === 0 && !this.stickerPacksFetchTried.has(p.packId),
    );
    if (unfetched.length > 0) {
      for (const p of unfetched) this.stickerPacksFetchTried.add(p.packId);
      await Promise.all(
        unfetched.map((p) =>
          this.rpc
            .call('getSticker', { packId: p.packId, stickerId: 0 }, ignoreResult, {
              timeoutMs: 30_000,
            })
            .catch(() => undefined),
        ),
      );
      packs = (await list()).filter((p) => p.installed);
    }
    return packs
      .flatMap((p): StickerPackInfo[] => {
        if (p.stickers.length === 0 || !/^[\da-f]+$/u.test(p.packId)) return [];
        const stickers = p.stickers.map((s): StickerPackSticker => ({
          stickerId: s.id,
          emoji: s.emoji,
        }));
        const cover = p.cover ?? p.stickers[0];
        return [
          {
            packId: p.packId,
            title: p.title,
            author: p.author,
            cover: { stickerId: cover?.id ?? 0, emoji: cover?.emoji ?? '' },
            stickers,
          },
        ];
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /**
   * See `ChatBackend.getStickerPack`. First makes sure the account knows the
   * pack and has downloaded it, the same way showing the sticker does
   * (`resolveStickerUrl`: registers a history sticker's pack via 0019, then
   * `getSticker` downloads the whole pack as a side effect; no install, no
   * sync). That call's outcome is ignored here: the listing below is the
   * judge of whether the pack is usable. Unlike `listStickerPacks`, an
   * uninstalled pack is returned (with `installed: false`).
   */
  async getStickerPack(sticker: StickerContent): Promise<StickerPackDetails> {
    this.assertAccount();
    if (!HEX_ID.test(sticker.packId))
      throw new SignalCliError('user', "This sticker pack can't be shown.");
    await this.resolveStickerUrl(sticker).catch(() => undefined);
    const pack = (await this.rpc.call('listStickerPacks', {}, wireStickerPacks)).find(
      (p) => p.packId === sticker.packId,
    );
    if (!pack || pack.stickers.length === 0)
      throw new SignalCliError('user', 'This sticker pack is not available.');
    const cover = pack.cover ?? pack.stickers[0];
    return {
      packId: pack.packId,
      title: pack.title,
      author: pack.author,
      installed: pack.installed,
      cover: { stickerId: cover?.id ?? 0, emoji: cover?.emoji ?? '' },
      stickers: pack.stickers.map((s): StickerPackSticker => ({ stickerId: s.id, emoji: s.emoji })),
    };
  }

  /**
   * See `ChatBackend.installStickerPack`. A history sticker's pack is
   * registered first (0019, from the backup frame's own key) when this
   * build can, since `installKnownStickerPack` only knows packs the sticker
   * store already holds. Only the hex pack id crosses the RPC boundary; the
   * key is looked up by signal-cli itself.
   */
  async installStickerPack(sticker: StickerContent): Promise<void> {
    this.assertAccount();
    if (!this.stickerPackInstallSupported)
      throw new SignalCliError('user', 'Installing sticker packs needs a newer signal-cli.');
    if (!HEX_ID.test(sticker.packId))
      throw new SignalCliError('user', "This sticker pack can't be installed.");
    if (this.historyStickerPackSupported && sticker.backupAttachment) {
      await this.rpc.call(
        'registerHistoryStickerPack',
        { id: sticker.backupAttachment.id },
        ignoreResult,
      );
    }
    await this.rpc.call('installKnownStickerPack', { packId: sticker.packId }, ignoreResult, {
      timeoutMs: 60_000,
    });
    // The listing the picker reads changes now; the next one re-fetches.
    this.stickerPacksFetchTried.delete(sticker.packId);
  }

  retainStickerUrl(sticker: StickerContent): void {
    this.attachments.retain(stickerCacheId(sticker));
  }

  releaseStickerUrl(sticker: StickerContent): void {
    this.attachments.release(stickerCacheId(sticker));
  }

  /**
   * See `ChatBackend.requestAttachmentBackfill`. A no-op against a daemon
   * that doesn't implement it (`supportsAttachmentBackfill` is false): the
   * caller already decided to ask only because this returned true, but a
   * backend swap or a stale capability check must not send an RPC the
   * daemon would otherwise reject with "method not found".
   */
  async requestAttachmentBackfill(
    conversationId: ConversationId,
    targetAuthorId: string,
    targetSentAt: number,
    attachmentIds: readonly string[],
  ): Promise<void> {
    this.assertAccount();
    if (!this.attachmentBackfillSupported) return;
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    const target =
      parsed.kind === 'group' ? { groupId: parsed.target } : { recipient: parsed.target };
    await this.rpc.call(
      'requestAttachmentBackfill',
      {
        ...target,
        targetAuthor: targetAuthorId,
        targetTimestamp: String(targetSentAt),
        attachmentIds,
      },
      ignoreResult,
    );
  }

  /**
   * Asks the primary device to resend contacts, groups and the block list
   * (Settings → Connection → "Sync contacts and groups"), then force-re-lists
   * both so anything already known lands immediately; anything the phone
   * sends afterwards arrives as an ordinary contacts/groups sync (see `apply`,
   * case 'contactsChanged') and needs no further action here.
   */
  async syncContactsAndGroups(): Promise<void> {
    this.assertAccount();
    await this.rpc.call('sendSyncRequest', undefined, ignoreResult);
    await Promise.all([this.directory.loadContacts(true), this.directory.loadGroups(true)]);
  }

  /**
   * `getUserStatus`: asks the server (contact discovery for a number, the
   * username directory for a username) whether the person is on Signal. It
   * sends nothing to them. A found person's number and ACI are recorded as
   * aliases (`DirectPeers.learnPair`) before the id is returned, so the id is
   * the canonical one every later envelope from them resolves to: a DM opened
   * under it can never fork from the one their first message lands in.
   * Nothing here is logged: numbers, usernames and ids stay out of the logs.
   */
  async lookupRecipient(query: RecipientQuery): Promise<RecipientLookup> {
    this.assertAccount();
    const params: RpcParams =
      query.kind === 'phone' ? { recipient: [query.e164] } : { username: [query.username] };
    let rows;
    try {
      rows = await this.rpc.call('getUserStatus', params, wireUserStatuses);
    } catch (error) {
      if (isSignalCliError(error) && error.kind === 'rate-limited') {
        return { status: 'rate-limited' };
      }
      throw error;
    }
    const row = rows[0];
    if (!row?.isRegistered || !row.uuid) return { status: 'not-registered' };
    const number = row.number ?? (query.kind === 'phone' ? query.e164 : undefined);
    const username = row.username ?? (query.kind === 'username' ? query.username : undefined);
    this.identity.learnPair(row.uuid, number);
    this.peers?.learnPair(row.uuid, number);
    const selfResolved = this.identity.resolve(row.uuid);
    const id =
      selfResolved === row.uuid ? (this.peers?.resolve(row.uuid) ?? row.uuid) : selfResolved;
    const name = this.directory.contact(id)?.name;
    return {
      status: 'found',
      id,
      ...(number ? { number } : {}),
      ...(username ? { username } : {}),
      ...(name ? { name } : {}),
    };
  }

  // ─── Commands ──────────────────────────────────────────────────────────

  async send(input: SendInput): Promise<SendResult> {
    this.assertAccount();
    const target = targetParams(input.conversationId, this.identity.aliases);
    const stamp = this.clock.now().toString(36);
    let sticker: string | undefined;
    if (input.sticker) {
      try {
        sticker = stickerParam(input.sticker.packId, input.sticker.stickerId);
      } catch {
        throw new SignalCliError('user', "This sticker can't be sent.");
      }
    }
    const encoded = await Promise.all(
      (input.attachments ?? []).map((file, i) =>
        encodeOutgoing(file, `local:${stamp}:${i}`, this.options.thumbnailer),
      ),
    );
    const encodedPreview = input.preview
      ? await encodeOutgoingPreview(input.preview, `local:${stamp}:preview`)
      : undefined;
    const params = {
      ...target,
      ...messageParams({
        body: input.body,
        ranges: input.ranges,
        ...(input.quote ? { quote: input.quote } : {}),
        ...(sticker ? { sticker } : {}),
        attachments: encoded.map((e) => e.param),
        ...(encodedPreview ? { preview: encodedPreview.param } : {}),
        // Defensive: never forward customEmoji to a daemon that hasn't
        // advertised support for it, even if the caller built one anyway.
        ...(this.customEmojiSupported && input.customEmoji
          ? { customEmoji: input.customEmoji }
          : {}),
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
    // The message's own sentAt (not "now"), consistent with every other notePeer call.
    this.notePeer(input.conversationId, result.timestamp);
    const out: SendResult = { sentAt: result.timestamp };
    if (encoded.length > 0) out.attachments = encoded.map((e) => e.attachment);
    if (encodedPreview) out.preview = encodedPreview.preview;
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
        ...(this.customEmojiSupported && input.customEmoji
          ? { customEmoji: input.customEmoji }
          : {}),
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

  async markRead(
    _conversationId: ConversationId,
    messages: MessageRef[],
    options?: MarkReadOptions,
  ): Promise<ReadSummary> {
    this.assertAccount();
    // An older signal-cli would treat `syncOnly` as a plain receipt: never send it one.
    if (options?.syncOnly && !this.readSyncSupported) return summariseReadReplies([]);
    // Receipts are addressed to each message's author, not to the conversation.
    const byAuthor = new Map<string, number[]>();
    for (const m of messages) {
      if (this.identity.isSelf(m.authorId) || m.authorId === this.selfId) continue;
      byAuthor.set(m.authorId, [...(byAuthor.get(m.authorId) ?? []), m.sentAt]);
    }
    const replies = await Promise.all(
      [...byAuthor].map(([author, timestamps]) =>
        this.rpc.call(
          'sendReceipt',
          {
            recipient: author,
            targetTimestamp: timestamps,
            type: 'read',
            ...(options?.syncOnly ? { syncOnly: true } : {}),
          },
          ignoreResult,
        ),
      ),
    );
    return summariseReadReplies(replies);
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

  /**
   * `sendMessageRequestResponse`: signal-cli shares (accept) or withdraws
   * (delete) profile sharing with a contact, and tells the user's other
   * devices. For a group it only sends that sync message, so deleting one
   * also quits it (`quitGroup`, local copy included) — a failed quit never
   * blocks the delete: the app hides the chat regardless.
   */
  async respondToMessageRequest(
    conversationId: ConversationId,
    response: MessageRequestResponse,
  ): Promise<void> {
    this.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    const target = targetParams(conversationId, this.identity.aliases);
    if ('noteToSelf' in target) return;
    try {
      await this.rpc.call(
        'sendMessageRequestResponse',
        { ...target, type: response },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
    if (parsed.kind === 'group') {
      if (response === 'delete') {
        try {
          await this.rpc.call('quitGroup', { groupId: parsed.target, delete: true }, ignoreResult);
        } catch (error) {
          log.warn('leaving a deleted group request failed', {
            kind: isSignalCliError(error) ? error.kind : 'unknown',
          });
        }
        this.directory.invalidateGroups();
      }
      return;
    }
    // The contact's `profileSharing` just changed. Re-read in the background:
    // listing contacts can take a while, and the answer is already applied here.
    void this.directory.loadContacts(true);
  }

  /** `block` / `unblock` (signal-cli syncs both to the phone). */
  async setBlocked(conversationId: ConversationId, blocked: boolean): Promise<void> {
    this.assertAccount();
    const parsed = parseConversationId(conversationId);
    if (!parsed) throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
    if (parsed.kind === 'direct' && this.identity.aliases.has(parsed.target)) return;
    try {
      await this.rpc.call(
        blocked ? 'block' : 'unblock',
        parsed.kind === 'group' ? { groupId: [parsed.target] } : { recipient: [parsed.target] },
        ignoreResult,
      );
    } catch (error) {
      throw enrichSendError(error);
    }
    // Re-read in the background (see respondToMessageRequest): the caller
    // already shows the answer.
    void Promise.all([this.directory.loadContacts(true), this.directory.loadGroups(true)]).catch(
      (error: unknown) => {
        log.warn('re-reading the directory after a block failed', {
          kind: isSignalCliError(error) ? error.kind : 'unknown',
        });
      },
    );
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

/** A sticker pack id as signal-cli prints it: hex. */
const HEX_ID = /^[\da-f]+$/u;

/**
 * Why a `getSticker` call failed, from signal-cli's own message prefix —
 * never the message itself, which names the pack and sticker ids.
 */
function stickerFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('Could not find sticker')) return 'not-found';
  if (message.startsWith('An error occurred reading sticker')) return 'read-error';
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' ? kind : 'unknown';
}

/** One diagnostic line per sticker that couldn't be fetched (no ids or keys). */
function logStickerFailure(registration: string, first: unknown, last: unknown): void {
  const code = (first as { code?: unknown } | null)?.code;
  log.warn('sticker fetch failed', {
    registration,
    first: stickerFailureReason(first),
    last: stickerFailureReason(last),
    ...(typeof code === 'number' ? { code } : {}),
  });
}
