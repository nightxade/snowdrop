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
  avatarKey,
  colorForId,
  parseConversationId,
  type Attachment,
  type AvatarRef,
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
  raceAbort,
  systemClock,
  throwIfAborted,
  systemScheduler,
  type Cancel,
  type Clock,
  type Scheduler,
  type Unsubscribe,
  ignore,
  ignored,
} from '@/core/lib';
import type { KeyValueStorage } from '@/core/persistence';
import type {
  AbortOptions,
  BackendEvents,
  ChatBackend,
  ConversationPatch,
  EditInput,
  EditResult,
  GroupChange,
  HistoryPage,
  HistoryQuery,
  HistoryReadRef,
  HistoryReadState,
  LinkFlow,
  MarkReadOptions,
  ReadSummary,
  MessageRef,
  MessageRequestResponse,
  NewGroupInput,
  PhonePrivacyPatch,
  PhonePrivacySettings,
  PinInput,
  PollVoteInput,
  ProfileUpdate,
  ReactInput,
  RecipientLookup,
  SafetyNumber,
  SendInput,
  SendResult,
  StickerPackDetails,
  StickerPackInfo,
  Feature,
} from '../types';
import { FeatureStore } from '../features';
import {
  AttachmentResolver,
  encodeOutgoing,
  encodeOutgoingPreview,
  type Thumbnailer,
} from './attachments';
import { AvatarResolver } from './avatars';
import {
  featuresForVersion,
  supportsHistoryStickerPack as detectHistoryStickerPackSupport,
} from './capabilities';
import { Directory } from './directory';
import { isSignalCliError, SignalCliError } from './errors';
import { EventPump } from './EventPump';
import { GroupOps } from './GroupOps';
import { HistoryFacade } from './HistoryFacade';
import { isUuid, SelfIdentity } from './identity';
import {
  enrichSendError,
  messageParams,
  pinDurationParam,
  pollCreateParams,
  pollVoteParams,
  profileParams,
  recipientFailures,
  stickerParam,
  summariseReadReplies,
  targetParams,
} from './params';
import { DirectPeers } from './peers';
import { SafetyOps } from './SafetyOps';
import { StickerOps } from './StickerOps';
import { cursorStorageKey } from './storageKeys';
import { HttpTransport } from './httpTransport';
import { JsonRpcClient, type FetchLike, type RpcParams } from './rpc';
import type { EventStreamState, EventSubscription, SignalCliTransport } from './transport';
import { isRecord, unknownValue } from './validate';
import {
  wireAccounts,
  wireFinishLink,
  wireSendResult,
  wirePhonePrivacy,
  wireStartLink,
  wireUserStatuses,
  wireVersion,
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

/** Allow time to scan the code and transfer history after provisioning. */
const LINK_TIMEOUT_MS = 15 * 60_000;
/**
 * How long the initial queries (self, contacts, conversations) wait for the
 * contact listing before answering from the cache (see `contactsForListing`).
 */
const LISTING_CONTACTS_WAIT_MS = 5_000;
/** Quotes of messages sent this session, for edits whose caller omits them. */
const SENT_QUOTES_MAX = 500;

/** For commands whose result we don't need (it varies across daemon versions). */
const ignoreResult = unknownValue;

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

export class SignalCliBackend implements ChatBackend {
  /**
   * What every signal-cli connection offers; the version-dependent features
   * (capabilities.ts) are added after connect.
   */
  static readonly FEATURES: ReadonlySet<Feature> = new Set<Feature>([
    'history',
    'historyArchive',
    'pins',
    'polls',
    'adminDelete',
    'conversationSettings',
    'groups',
    'lookup',
    'messageRequests',
    'blocking',
    'safetyNumbers',
    'attachmentUrls',
    'attachmentBlob',
    'avatarUrls',
    'stickers',
    'stickerUrls',
    'profile',
    'phonePrivacyUpdate',
    'contactSync',
    'deviceLinking',
  ]);

  readonly kind = 'signal-cli' as const;
  readonly link: LinkFlow;

  private readonly rpc: JsonRpcClient;
  private readonly emitter = new Emitter<BackendEvents>();
  private readonly clock: Clock;
  private readonly scheduler: Scheduler;
  private readonly attachments: AttachmentResolver;
  private readonly avatars: AvatarResolver;
  private readonly stickers: StickerOps;
  private readonly historyFacade: HistoryFacade;
  private readonly pump: EventPump;
  private readonly groups: GroupOps;
  private readonly safety: SafetyOps;
  /** The last `avatarVersion` handed out for the user's own edit (see `updateProfile`). */
  private selfAvatarVersion = 0;
  private readonly directory: Directory;
  /** The bounded wait on the contact listing in flight (see `contactsForListing`). */
  private listingWait: Promise<void> | null = null;
  private readonly sentQuotes = new Map<string, Quote>();
  private readonly debugLog: (message: string, detail?: unknown) => void;

  private status: ConnectionStatus = 'offline';
  private preferredAccount: string | null;
  private stream: EventSubscription | null = null;
  private readonly transport: SignalCliTransport;
  private connecting: Promise<void> | null = null;
  /** Bumped on disconnect so queued work from an old session is dropped. */
  private session = 0;

  // Per-account state, set on connect.
  private identity = new SelfIdentity('');
  private multiAccount = true;
  private peers: DirectPeers | null = null;
  /**
   * What the connected daemon can do beyond the common core: the static
   * `FEATURES` always, plus the version-dependent ones decided by
   * capabilities.ts after the version probe (dropped again on disconnect).
   */
  readonly capabilities = new FeatureStore(SignalCliBackend.FEATURES);
  /** Whether the connected daemon can register a history sticker's pack key (see capabilities.ts). */
  private historyStickerPackSupported = false;
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
    this.avatars = new AvatarResolver({ rpc: this.rpc, now: () => this.clock.now() });
    this.stickers = new StickerOps({
      rpc: this.rpc,
      attachments: this.attachments,
      assertAccount: () => {
        this.assertAccount();
      },
      historyStickerPackSupported: () => this.historyStickerPackSupported,
      canInstallPack: () => this.capabilities.features.has('stickerPackInstall'),
    });
    this.historyFacade = new HistoryFacade({
      rpc: this.rpc,
      clock: this.clock,
      identity: () => this.identity,
      peers: () => this.peers,
      contactsForListing: () => this.contactsForListing(),
      assertAccount: () => {
        this.assertAccount();
      },
    });
    this.directory = new Directory({
      rpc: this.rpc,
      now: () => this.clock.now(),
      scheduler: this.scheduler,
      identity: () => this.identity,
      peers: () => this.peers,
      storage: this.options.storage,
      debug: this.debugLog,
      onContactChanged: (contact) => {
        this.emitter.emit('contactUpdated', contact);
        // Only announce a conversation update for a contact already listed
        // (recorded local activity); a refreshed profile must not promote a
        // contact we've never messaged into a conversation on its own (see
        // listConversations).
        if (this.peers?.has(contact.id)) {
          this.emitter.emit('conversationUpdated', this.pump.directConversation(contact.id, 0));
        }
      },
      onGroupChanged: (conv) => {
        this.emitter.emit('conversationUpdated', conv);
      },
      onAvatarChanged: (ref) => {
        this.avatars.invalidate(avatarKey(ref));
      },
    });
    this.pump = new EventPump({
      emitter: this.emitter,
      clock: this.clock,
      directory: this.directory,
      debug: this.debugLog,
      storage: this.options.storage,
      session: () => this.session,
      identity: () => this.identity,
      peers: () => this.peers,
      cursorKey: () => this.cursorKey(),
      acknowledgeTransport: (cursor) => {
        this.transport.acknowledge?.(cursor);
      },
    });
    this.groups = new GroupOps({
      rpc: this.rpc,
      directory: this.directory,
      avatars: this.avatars,
      assertAccount: () => {
        this.assertAccount();
      },
      selfId: () => this.selfId,
      emitConversationUpdated: (conversation) => {
        this.emitter.emit('conversationUpdated', conversation);
      },
      emitOwnSystem: (conversationId, sentAt, text, kind) => {
        this.pump.emitOwnSystem(conversationId, sentAt, text, kind);
      },
      resultTimestamp: (result) => this.resultTimestamp(result),
      nameOf: (id) => this.pump.nameOf(id),
      applyTimer: (conversationId, seconds) => {
        this.pump.applyTimer(conversationId, seconds);
      },
    });
    this.safety = new SafetyOps({
      rpc: this.rpc,
      directory: this.directory,
      assertAccount: () => {
        this.assertAccount();
      },
      targetOf: (conversationId) => this.targetOf(conversationId),
      isAlias: (id) => this.identity.aliases.has(id),
    });
    this.link = {
      start: async (options) => {
        const { deviceLinkUri } = await this.rpc.call('startLink', undefined, wireStartLink, {
          account: null,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        return { uri: deviceLinkUri };
      },
      finish: async (uri, deviceName, options) => {
        const result = await this.rpc.call(
          'finishLink',
          { deviceLinkUri: uri, deviceName },
          wireFinishLink,
          {
            account: null,
            timeoutMs: LINK_TIMEOUT_MS,
            // Linking may complete on the daemon even if we stop waiting.
            mutating: true,
            ...(options?.signal ? { signal: options.signal } : {}),
          },
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
    if (this.stream) {
      // Already connected, or the stream is waiting to retry: a call now (the
      // UI's "Retry") skips that wait.
      this.stream.reconnectNow();
      return;
    }
    this.setStatus('connecting');
    try {
      await this.rpc.check({ timeoutMs: this.transport.checkTimeoutMs ?? 5_000 });
      const version = await this.probeVersion();
      this.historyStickerPackSupported = detectHistoryStickerPackSupport(version);
      this.capabilities.set([...SignalCliBackend.FEATURES, ...featuresForVersion(version)]);
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

  /** See `ChatBackend.readPhonePrivacy`: the stored configuration the phone synced to us. */
  async readPhonePrivacy(): Promise<PhonePrivacySettings> {
    this.assertAccount();
    if (!this.capabilities.features.has('phonePrivacy'))
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
    if (!this.capabilities.features.has('phonePrivacy'))
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
    const self = await this.getSelf();
    if (update.avatar === undefined) return self;
    // signal-cli stored (or deleted) the photo itself; show what was just set at once.
    const ref: AvatarRef = { kind: 'contact', id: self.id };
    this.avatars.prime(
      avatarKey(ref),
      update.avatar ? `data:${update.avatar.contentType};base64,${update.avatar.base64}` : null,
    );
    // Strictly newer than the last version we gave out, so a shown avatar always asks again.
    this.selfAvatarVersion = Math.max(
      this.clock.now(),
      this.selfAvatarVersion + 1,
      (self.avatarVersion ?? 0) + 1,
    );
    return { ...self, avatarVersion: this.selfAvatarVersion };
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
        void this.directory
          .loadGroups(true)
          .then(() => {
            if (stopped || session !== this.session) return;
            const count = this.directory.allGroups().length;
            // Still none: the phone's sync usually hasn't landed yet, so keep
            // checking. Once groups exist and the count settles, stop early.
            if (count > 0 && count === lastCount) {
              stopped = true;
              return;
            }
            lastCount = count;
          })
          // A daemon blip on one of these checks is not worth an unhandled rejection.
          .catch(ignored('a daemon blip on one group check; the next backoff step checks again'));
      }, delayMs);
    }
  }

  async disconnect(): Promise<void> {
    await this.connecting?.catch(
      ignored('disconnect only waits for the connect to settle; its caller got the failure'),
    );
    this.session++;
    this.historyFacade.close();
    this.listingWait = null;
    await this.closeStream();
    this.attachments.clear();
    this.avatars.clear();
    this.pump.clearGroupChanges();
    this.historyStickerPackSupported = false;
    this.capabilities.set(SignalCliBackend.FEATURES);
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
    this.avatars.clear();
    this.historyFacade.reset();
    this.listingWait = null;
    this.pump.clearGroupChanges();
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
    } catch (error) {
      ignore(error, 'storage unavailable: start from live events');
    }
    const stream = this.transport.subscribe({
      account: this.multiAccount ? this.selfId : null,
      resumeFrom,
      onEvent: (event) => {
        if (session === this.session) this.pump.onTransportEvent(event);
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

  /** Test hook: feeds a raw `receive` payload as if it came from the stream. */
  ingest(payload: unknown, cursor?: string): Promise<void> {
    return this.pump.ingest(payload, cursor);
  }

  hasPendingEvents(): boolean {
    return this.pump.hasPendingEvents();
  }

  /** Resolves once every queued incoming event has been applied. */
  idle(): Promise<void> {
    return this.pump.idle();
  }

  /** Persists the resume position once the sync engine has stored everything before it. */
  acknowledge(cursor: string): void {
    this.pump.acknowledge(cursor);
  }

  // ─── Queries ───────────────────────────────────────────────────────────

  /**
   * Waits for the contact listing, but not for long: a profile refresh can
   * take minutes, and the three initial queries (self, contacts,
   * conversations) must not all sit behind it. When the bound passes the
   * answer is built from what is cached; the listing keeps loading and
   * arrives as `contactUpdated` / `conversationUpdated`. Never rejects.
   */
  private contactsForListing(): Promise<void> {
    // One bound per load: the queries that follow each other (and the history
    // open inside them) share it instead of each waiting out its own.
    if (this.listingWait) return this.listingWait;
    const load = this.directory.loadContacts();
    let cancel: Cancel | undefined;
    const bound = new Promise<void>((resolve) => {
      cancel = this.scheduler.setTimeout(resolve, LISTING_CONTACTS_WAIT_MS);
    });
    const wait = Promise.race([load, bound]).then(() => cancel?.());
    this.listingWait = wait;
    void load.finally(() => {
      cancel?.();
      if (this.listingWait === wait) this.listingWait = null;
    });
    return wait;
  }

  async getSelf(): Promise<Contact> {
    this.assertAccount();
    await this.contactsForListing();
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
    await this.contactsForListing();
    const { archive: history } = await this.historyFacade.historyForListing();
    // After the (slow) history read: a listing that finished meanwhile is included.
    const contacts = this.directory.allContacts();
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
      this.contactsForListing(), // populates the cache directConversation's names read from.
    ]);
    const dms = new Map<string, Conversation>();
    for (const [peer, at] of this.peers?.entries() ?? []) {
      dms.set(peer, this.pump.directConversation(peer, at));
    }
    const { archive: history, unreadable } = await this.historyFacade.historyForListing();
    const dmIds = new Set([...dms.values()].map((conversation) => conversation.id));
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
        // Without the archive a DM known only from peer data can't be told from
        // a stale one: say so, so it isn't dropped for it.
        ...(unreadable && dmIds.has(conversation.id) ? { historyUnreadable: true } : {}),
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

  historyHasOutgoing(conversationId: ConversationId): Promise<boolean> {
    return this.historyFacade.historyHasOutgoing(conversationId);
  }

  fetchHistory(
    conversationId: ConversationId,
    query: HistoryQuery,
    options?: AbortOptions,
  ): Promise<HistoryPage> {
    return this.historyFacade.fetchHistory(conversationId, query, options);
  }

  remapHistoryMessages(messages: readonly Message[]): Promise<Message[]> {
    return this.historyFacade.remapHistoryMessages(messages);
  }

  getHistoryArchiveId(): Promise<string | null> {
    return this.historyFacade.getHistoryArchiveId();
  }

  readHistory(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyFacade.readHistory(messages);
  }

  getHistoryReadState(messages: readonly HistoryReadRef[]): Promise<HistoryReadState[]> {
    return this.historyFacade.getHistoryReadState(messages);
  }

  async resolveAttachmentUrl(
    _conversationId: ConversationId,
    attachment: Attachment,
    options?: { forceRefresh?: boolean } & AbortOptions,
  ): Promise<string> {
    this.assertAccount();
    throwIfAborted(options?.signal);
    // Downloads are shared and cached across callers: an abort only stops this
    // caller's wait, and the download still lands in the cache.
    return raceAbort(
      this.attachments.resolve(
        attachment,
        {},
        options?.forceRefresh === undefined ? {} : { forceRefresh: options.forceRefresh },
      ),
      options?.signal,
    );
  }

  async readAttachmentBlob(
    _conversationId: ConversationId,
    attachment: Attachment,
    options?: { maxBytes?: number } & AbortOptions,
  ): Promise<Blob> {
    this.assertAccount();
    throwIfAborted(options?.signal);
    return this.attachments.readBlob(attachment, {}, options?.maxBytes, options?.signal);
  }

  /**
   * The `getAvatar` calls that can produce `ref`'s picture, best first, or
   * none when we know it has none (so nothing is asked). Signal Desktop shows
   * the contact's own photo (the one the phone shares) before the profile
   * photo they chose, except for the user themselves, whose profile photo
   * is the one that counts. The contact photo is only worth asking for on a
   * saved contact, and the profile photo only when the profile says there is one.
   */
  private avatarAttempts(ref: AvatarRef): RpcParams[] {
    if (ref.kind === 'group') {
      const parsed = parseConversationId(ref.id);
      return parsed?.kind === 'group' ? [{ groupId: parsed.target }] : [];
    }
    const contact = this.directory.contact(ref.id);
    if (this.identity.isSelf(ref.id) || contact?.isSelf) return [{ profile: ref.id }];
    const attempts: RpcParams[] = [];
    if (contact?.inContacts) attempts.push({ contact: ref.id });
    if (contact?.hasAvatar) attempts.push({ profile: ref.id });
    return attempts;
  }

  async resolveAvatarUrl(ref: AvatarRef): Promise<string | null> {
    const attempts = this.avatarAttempts(ref);
    if (attempts.length === 0) return null;
    this.assertAccount();
    return this.avatars.resolve(avatarKey(ref), attempts);
  }

  peekAvatarUrl(ref: AvatarRef): string | null | undefined {
    if (this.avatarAttempts(ref).length === 0) return null;
    return this.avatars.peek(avatarKey(ref));
  }

  retainAttachmentUrl(attachment: Attachment): void {
    this.attachments.retain(attachment.id);
  }

  releaseAttachmentUrl(attachment: Attachment): void {
    this.attachments.release(attachment.id);
  }

  resolveStickerUrl(
    sticker: StickerContent,
    options?: { forceRefresh?: boolean },
  ): Promise<string> {
    return this.stickers.resolveStickerUrl(sticker, options);
  }

  listStickerPacks(): Promise<StickerPackInfo[]> {
    return this.stickers.listStickerPacks();
  }

  getStickerPack(sticker: StickerContent): Promise<StickerPackDetails> {
    return this.stickers.getStickerPack(sticker);
  }

  installStickerPack(sticker: StickerContent): Promise<void> {
    return this.stickers.installStickerPack(sticker);
  }

  retainStickerUrl(sticker: StickerContent): void {
    this.stickers.retainStickerUrl(sticker);
  }

  releaseStickerUrl(sticker: StickerContent): void {
    this.stickers.releaseStickerUrl(sticker);
  }

  /**
   * See `ChatBackend.requestAttachmentBackfill`. A no-op against a daemon
   * that doesn't implement it (no `attachmentBackfill` feature): the
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
    if (!this.capabilities.features.has('attachmentBackfill')) return;
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

  /** `send` target for a conversation, never addressing a recycled number's new owner. */
  private targetOf(conversationId: ConversationId): RpcParams {
    return targetParams(conversationId, this.identity.aliases, (id) =>
      this.peers ? this.peers.addressFor(id) : id,
    );
  }

  async send(input: SendInput, options?: AbortOptions): Promise<SendResult> {
    this.assertAccount();
    throwIfAborted(options?.signal);
    const target = this.targetOf(input.conversationId);
    if (input.poll) return this.sendPoll(input.conversationId, input.poll, target, options);
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
        ...((input.attachments ?? []).some((file) => file.voiceNote) ? { voiceNote: true } : {}),
        ...(encodedPreview ? { preview: encodedPreview.param } : {}),
        // Defensive: never forward customEmoji to a daemon that hasn't
        // advertised support for it, even if the caller built one anyway.
        ...(this.capabilities.features.has('customEmojiDelivery') && input.customEmoji
          ? { customEmoji: input.customEmoji }
          : {}),
      }),
    };
    let result;
    try {
      result = await this.rpc.call('send', params, wireSendResult, {
        timeoutMs: encoded.length > 0 ? 180_000 : 60_000,
        mutating: true,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      throw enrichSendError(error);
    }
    if (input.quote) this.rememberQuote(input.conversationId, result.timestamp, input.quote);
    const failures = recipientFailures(result);
    // The message's own sentAt (not "now"), consistent with every other notePeer call.
    this.pump.notePeer(input.conversationId, result.timestamp);
    const out: SendResult = { sentAt: result.timestamp };
    if (encoded.length > 0) out.attachments = encoded.map((e) => e.attachment);
    if (encodedPreview) out.preview = encodedPreview.preview;
    if (failures.length > 0) out.recipientFailures = failures;
    return out;
  }

  /** A poll is its own RPC (`sendPollCreate`) with its own params; the reply is a send result like any other. */
  private async sendPoll(
    conversationId: ConversationId,
    poll: NonNullable<SendInput['poll']>,
    target: RpcParams,
    options?: AbortOptions,
  ): Promise<SendResult> {
    let result;
    try {
      result = await this.rpc.call(
        'sendPollCreate',
        { ...target, ...pollCreateParams(poll) },
        wireSendResult,
        {
          timeoutMs: 60_000,
          mutating: true,
          ...(options?.signal ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      throw enrichSendError(error);
    }
    const failures = recipientFailures(result);
    this.pump.notePeer(conversationId, result.timestamp);
    return {
      sentAt: result.timestamp,
      ...(failures.length > 0 ? { recipientFailures: failures } : {}),
    };
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
  async edit(input: EditInput): Promise<EditResult> {
    this.assertAccount();
    const quote =
      input.quote ?? this.sentQuotes.get(`${input.conversationId}|${input.targetSentAt}`);
    const encodedPreview = input.preview
      ? await encodeOutgoingPreview(input.preview, `local:${input.targetSentAt}:preview`)
      : undefined;
    const params = {
      ...this.targetOf(input.conversationId),
      ...messageParams({
        body: input.body,
        ranges: input.ranges,
        ...(quote ? { quote } : {}),
        editTimestamp: input.targetSentAt,
        ...(encodedPreview ? { preview: encodedPreview.param } : {}),
        ...(this.capabilities.features.has('customEmojiDelivery') && input.customEmoji
          ? { customEmoji: input.customEmoji }
          : {}),
      }),
    };
    try {
      const result = await this.rpc.call('send', params, wireSendResult, { timeoutMs: 60_000 });
      return {
        sentAt: result.timestamp,
        ...(encodedPreview ? { preview: encodedPreview.preview } : {}),
      };
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

  async votePoll(input: PollVoteInput): Promise<void> {
    await this.command('sendPollVote', input.conversationId, pollVoteParams(input));
  }

  async terminatePoll(conversationId: ConversationId, pollSentAt: number): Promise<void> {
    await this.command('sendPollTerminate', conversationId, { pollTimestamp: pollSentAt });
  }

  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    this.assertAccount();
    const target = this.targetOf(conversationId);
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
    if (options?.syncOnly && !this.capabilities.features.has('readSync'))
      return summariseReadReplies([]);
    // Receipts are addressed to each message's author, not to the conversation.
    // The user's own messages never get a receipt, but a sync-only read may name
    // them: that is how the phone learns the reactions and votes on them were
    // seen (Desktop sends the same sync, with the user as the message's author).
    const byAuthor = new Map<string, number[]>();
    for (const m of messages) {
      const own = this.identity.isSelf(m.authorId) || m.authorId === this.selfId;
      if (own && !options?.syncOnly) continue;
      const author = own ? this.selfId : m.authorId;
      byAuthor.set(author, [...(byAuthor.get(author) ?? []), m.sentAt]);
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
   */
  async updateConversation(
    conversationId: ConversationId,
    patch: ConversationPatch,
  ): Promise<void> {
    return this.groups.updateConversation(conversationId, patch);
  }

  async updateGroup(conversationId: ConversationId, change: GroupChange): Promise<void> {
    return this.groups.updateGroup(conversationId, change);
  }

  async createGroup(input: NewGroupInput): Promise<Conversation> {
    return this.groups.createGroup(input);
  }

  async leaveGroup(
    conversationId: ConversationId,
    newAdminIds: readonly string[] = [],
  ): Promise<void> {
    return this.groups.leaveGroup(conversationId, newAdminIds);
  }

  async respondToMessageRequest(
    conversationId: ConversationId,
    response: MessageRequestResponse,
  ): Promise<void> {
    return this.safety.respondToMessageRequest(conversationId, response);
  }

  async getSafetyNumber(contactId: string): Promise<SafetyNumber | null> {
    return this.safety.getSafetyNumber(contactId);
  }

  async verifyIdentity(contactId: string, digits: string): Promise<void> {
    return this.safety.verifyIdentity(contactId, digits);
  }

  async approveIdentity(contactId: string): Promise<void> {
    return this.safety.approveIdentity(contactId);
  }

  async setBlocked(conversationId: ConversationId, blocked: boolean): Promise<void> {
    return this.safety.setBlocked(conversationId, blocked);
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
      await this.rpc.call(method, { ...this.targetOf(conversationId), ...params }, ignoreResult);
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
