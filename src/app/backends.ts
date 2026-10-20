/**
 * The backend registry: every transport Snowdrop can run on, registered here in
 * the composition root. A registration says how to load the adapter (its own
 * chunk), which optional `ChatBackend` methods it implements (so services can
 * be wired before it loads), where history is kept, and any adapter-specific
 * wiring (the demo's liveliness switch and seeded spaces).
 *
 * Adding an adapter = its folder under `core/backend/<kind>/` plus one entry
 * in `BUILTIN_BACKENDS` below (and its folder in eslint's `adapterZones`).
 * Settings parsing, `deferredBackend`, Settings → Connection and plugins'
 * `ctx.backend.kind` all read from the registry.
 */
import type { BackendKind, BackendOption, ChatBackend } from '@/core/backend';
// Type-only: the adapters themselves are loaded on demand (one chunk each).
import type { MockBackend } from '@/core/backend/mock';
import type { FetchLike } from '@/core/backend/signal-cli';
import type { Clock, Scheduler, Unsubscribe } from '@/core/lib';
import {
  MemoryMessageRepository,
  type KeyValueStorage,
  type MessageRepository,
} from '@/core/persistence';
import type { SettingsSchema } from '@/core/plugins';
import type { ConnectionSettings, Stores } from '@/core/stores';
import { isTauri } from '@/platform/detect';
import { deferredBackend, type OptionalMethod } from './deferredBackend';
import { deferredRepository } from './deferredRepository';

/** What an adapter factory gets from the app. */
export interface BackendEnvironment {
  clock: Clock;
  scheduler: Scheduler;
  /** Key-value storage for transport state (resume positions, peers). */
  storage: KeyValueStorage;
  /** The persisted connection settings at startup. */
  connection: Readonly<ConnectionSettings>;
  /** Persists a connection setting the adapter discovered (signal-cli's account). */
  updateConnection(patch: Partial<ConnectionSettings>): void;
  /** Test and host overrides. */
  overrides: { fetch?: FetchLike; mockLatencyMs?: number; mockBulkMessages?: number };
}

export type ChatBackendFactory = (env: BackendEnvironment) => ChatBackend;

/** Where a transport's message history is kept. */
export type HistoryStore =
  /** In memory: the transport serves history itself, or it's regenerated each launch (demo). */
  | { kind: 'memory' }
  /** IndexedDB database `name`: the transport keeps no history, so Snowdrop persists what it sees. */
  | { kind: 'indexeddb'; name: string };

/** App-side hooks for a running adapter. */
export interface BackendApp {
  stores: Stores;
}

export interface BackendRegistration extends BackendOption {
  /** Loads the adapter's chunk and returns its factory. */
  load(): Promise<ChatBackendFactory>;
  /**
   * Exactly the optional `ChatBackend` methods the adapter implements (checked
   * against the real adapters by `deferredBackend.test.ts`).
   */
  capabilities: ReadonlySet<OptionalMethod>;
  history: HistoryStore;
  /**
   * Adapter-specific options, described like plugin settings. Reserved for
   * adapters registered later: Settings → Connection renders the built-in
   * signal-cli fields itself and doesn't generate a form from this yet.
   */
  settingsSchema?: SettingsSchema;
  /** Runs once after the first successful start (the demo seeds example spaces). */
  onStarted?(backend: ChatBackend, app: BackendApp): void;
  /** Wires adapter behaviour to settings for the instance's lifetime; returns its cleanup. */
  attach?(backend: ChatBackend, app: BackendApp): Unsubscribe;
}

export class DuplicateBackendError extends Error {
  override name = 'DuplicateBackendError';
}

const KIND = /^[a-z][a-z0-9-]{0,31}$/u;

export class BackendRegistry {
  private readonly byKind = new Map<BackendKind, BackendRegistration>();

  constructor(registrations: readonly BackendRegistration[] = []) {
    for (const r of registrations) this.register(r);
  }

  register(registration: BackendRegistration): void {
    if (!KIND.test(registration.kind))
      throw new TypeError(`Invalid backend kind "${registration.kind}"`);
    if (this.byKind.has(registration.kind))
      throw new DuplicateBackendError(`Backend "${registration.kind}" is already registered`);
    this.byKind.set(registration.kind, registration);
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  get(kind: string): BackendRegistration | undefined {
    return this.byKind.get(kind);
  }

  /** Registration order: the order the UI lists them in. */
  list(): readonly BackendRegistration[] {
    return [...this.byKind.values()];
  }

  /** What the UI shows (kind, label, description) without the loaders. */
  options(): readonly BackendOption[] {
    return this.list().map(({ kind, label, description }) => ({
      kind,
      label,
      ...(description === undefined ? {} : { description }),
    }));
  }
}

/** The demo: a seeded, simulated world. */
const mockBackend: BackendRegistration = {
  kind: 'mock',
  label: 'Demo',
  description: 'A simulated community, no account needed.',
  load: () =>
    import('@/core/backend/mock').then(
      ({ MockBackend }) =>
        (env) =>
          new MockBackend({
            clock: env.clock,
            scheduler: env.scheduler,
            latencyMs: env.overrides.mockLatencyMs ?? 120,
            ...(env.overrides.mockBulkMessages
              ? { bulkMessages: env.overrides.mockBulkMessages }
              : {}),
          }),
    ),
  capabilities: new Set([
    'fetchHistory',
    'adminDelete',
    'pinMessage',
    'updateConversation',
    'readAttachmentBlob',
    'listStickerPacks',
    'getStickerPack',
    'installStickerPack',
  ]),
  // The world is regenerated relative to "now" on each launch; persisting it would mix timelines.
  history: { kind: 'memory' },
  onStarted(backend, { stores }) {
    const { world } = backend as MockBackend;
    // Demo-only defaults so the community-style structure is visible on first run.
    // Never applied to a real account, and never re-applied after the user changes them.
    stores.spaces.getState().seedDefaults(world.defaultSpaces);
    stores.local.getState().seedDefaults(world.defaultLocal);
  },
  attach(backend, { stores }) {
    const { liveliness } = backend as MockBackend;
    const sync = (): void => {
      const on = stores.settings.getState().connection.mockLiveliness;
      if (on && backend.getStatus() === 'online') liveliness.start();
      else liveliness.stop();
    };
    sync();
    const offSettings = stores.settings.subscribe((s, prev) => {
      if (s.connection !== prev.connection) sync();
    });
    const offStatus = backend.on('status', sync);
    return () => {
      offSettings();
      offStatus();
      liveliness.stop();
    };
  },
};

/**
 * signal-cli. In the browser: the HTTP daemon (JSON-RPC + SSE) through the
 * dev proxy. In the desktop app: a transport whose Rust side runs the
 * bundled signal-cli itself (or proxies an external daemon), see
 * src/platform/tauri. The transport is picked here, so core/ stays
 * free of Tauri.
 */
const signalCliBackend: BackendRegistration = {
  kind: 'signal-cli',
  label: 'signal-cli',
  description: 'Your Signal account, through signal-cli.',
  load: async () => {
    const [{ SignalCliBackend }, desktop] = await Promise.all([
      import('@/core/backend/signal-cli'),
      isTauri() ? import('@/platform/tauri') : null,
    ]);
    return (env) =>
      new SignalCliBackend({
        baseUrl: env.connection.daemonUrl,
        ...(desktop
          ? { transport: new desktop.TauriTransport({ desktop: env.connection.desktop }) }
          : {}),
        account: env.connection.account,
        ...(env.overrides.fetch ? { fetch: env.overrides.fetch } : {}),
        clock: env.clock,
        scheduler: env.scheduler,
        storage: env.storage,
        onAccountSelected: (account) => {
          env.updateConnection({ account });
        },
      });
  },
  capabilities: new Set([
    'fetchHistory',
    'remapHistoryMessages',
    'readHistory',
    'getHistoryReadState',
    'adminDelete',
    'pinMessage',
    'updateConversation',
    'resolveAttachmentUrl',
    'readAttachmentBlob',
    'retainAttachmentUrl',
    'releaseAttachmentUrl',
    'resolveStickerUrl',
    'retainStickerUrl',
    'releaseStickerUrl',
    'listStickerPacks',
    'getStickerPack',
    'installStickerPack',
    'acknowledge',
    'link',
    'syncContactsAndGroups',
  ]),
  // The daemon keeps no history.
  history: { kind: 'indexeddb', name: 'snowdrop-signal-cli' },
};

/** Every transport this build knows, in the order the UI lists them. */
export const BUILTIN_BACKENDS: readonly BackendRegistration[] = [mockBackend, signalCliBackend];

/** Used before the user has chosen a transport, and for an unknown stored kind. */
export const DEFAULT_BACKEND: BackendKind = 'mock';

export interface BackendConnection {
  /** Usable immediately; forwards to the adapter once its chunk has loaded. */
  backend: ChatBackend;
  /** The real adapter, once loaded. */
  ready: Promise<ChatBackend>;
  repository: MessageRepository;
}

/**
 * Starts loading a registered adapter and wraps it so services can be wired
 * synchronously (`deferredBackend`), with the repository its history needs.
 */
export function connectBackend(
  registration: BackendRegistration,
  env: BackendEnvironment,
  repository?: MessageRepository,
): BackendConnection {
  const ready = registration.load().then((factory) => factory(env));
  return {
    backend: deferredBackend(registration.kind, registration.capabilities, ready),
    ready,
    repository: repository ?? createRepository(registration.history),
  };
}

function createRepository(history: HistoryStore): MessageRepository {
  // No IndexedDB (private modes, tests): history lasts for the session.
  if (history.kind === 'memory' || typeof indexedDB === 'undefined')
    return new MemoryMessageRepository();
  // Its own chunk (with idb): the demo never needs it.
  return deferredRepository(
    import('@/core/persistence/IdbMessageRepository').then((m) =>
      m.IdbMessageRepository.open(history.name),
    ),
  );
}
