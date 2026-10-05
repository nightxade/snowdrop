/**
 * Composition root: the only place that knows which concrete backend,
 * repository and plugins are in use. Everything else receives its
 * dependencies explicitly, which keeps core/ testable and adapters swappable.
 * Transports are registered in `backends.ts`, the plugin host's services are
 * in `pluginHost.ts` and the headless core commands in `coreCommands.ts`.
 */
import type { ChatBackend, DesktopAdmin, StorageAdmin } from '@/core/backend';
// Type-only: the adapter itself is loaded on demand (its own chunk).
import type { FetchLike } from '@/core/backend/signal-cli';
import { type CommandRegistry, isMacPlatform, KeybindDispatcher } from '@/core/commands';
import {
  systemClock,
  systemScheduler,
  type Clock,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import {
  APPEARANCE_BOOT_KEY,
  bindPersistence,
  defaultStorage,
  type PersistenceBinding,
  loadVersioned,
  type KeyValueStorage,
  type MessageRepository,
} from '@/core/persistence';
import { BUILTIN_PLUGINS, PluginRuntime, Registries } from '@/core/plugins';
import {
  browserNotificationApi,
  exportHistory,
  HistoryService,
  NotificationService,
  ReceiptBuffer,
  SendService,
  SyncService,
  type NotificationApi,
} from '@/core/services';
import {
  createSettingsSchema,
  createStores,
  localSchema,
  selectLocalData,
  selectSettingsData,
  selectSpacesData,
  spacesSchema,
  type Stores,
} from '@/core/stores';
import { applyAppearance, toTheme, type ThemeDocument } from '@/core/themes';
import { focusConversation, type AppAdmin } from '@/ui/hooks';
import { withUiPlugins } from '@/ui/plugins';
import {
  BackendRegistry,
  BUILTIN_BACKENDS,
  connectBackend,
  DEFAULT_BACKEND,
  type BackendRegistration,
} from './backends';
import { registerCoreCommands } from './coreCommands';
import { createPluginHost } from './pluginHost';
import {
  desktopAdmin,
  desktopNotificationApi,
  desktopStorageAdmin,
  installDesktopLinks,
  isTauri,
} from './platform';

export interface SnowdropOptions {
  storage?: KeyValueStorage;
  /** Where themes are applied; omit for headless use (tests). */
  document?: ThemeDocument;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Mock network latency in ms. */
  mockLatencyMs?: number;
  /** signal-cli transport override (tests). */
  fetch?: FetchLike;
  /** Message repository override (tests); defaults per backend. */
  repository?: MessageRepository;
  /** Desktop notifications (tests inject a fake); defaults to the browser's (native in the desktop app). */
  notificationApi?: NotificationApi;
  /**
   * Safe mode (`?safe=1`, or Shift held while loading): imported themes and
   * Custom CSS are not applied, so a broken one can always be removed.
   */
  safeMode?: boolean;
  /** The transports to choose from (tests); defaults to `BUILTIN_BACKENDS`. */
  backends?: BackendRegistry;
}

export interface Snowdrop {
  stores: Stores;
  backend: ChatBackend;
  /** Every registered transport; `backend` is the one this instance runs on. */
  backends: BackendRegistry;
  repository: MessageRepository;
  registries: Registries;
  commands: CommandRegistry;
  keybinds: KeybindDispatcher;
  plugins: PluginRuntime;
  sync: SyncService;
  send: SendService;
  history: HistoryService;
  /** Resolves with the concrete adapter once its chunk has loaded (dev tools, tests). */
  backendReady: Promise<ChatBackend>;
  notifications: NotificationService;
  admin: AppAdmin;
  /** The desktop app's signal-cli management; null in the browser. */
  desktop: DesktopAdmin | null;
  /**
   * Encrypted storage (docs/ENCRYPTION.md): Settings → Privacy & security's
   * recovery key, passphrase, keyring and erase controls. The same admin
   * `StorageGate` used to unlock before this instance existed; null in the
   * browser, where there's no vault.
   */
  storageAdmin: StorageAdmin | null;
  /** True when started in safe mode (custom themes and Custom CSS off). */
  readonly safeMode: boolean;
  /** Connects, syncs and starts plugins. Safe to call again after a failed start (retry). */
  start(): Promise<void>;
  /** Writes debounced persisted state now (call on page hide). */
  flush(): void;
  dispose(): Promise<void>;
}

export function createSnowdrop(options: SnowdropOptions = {}): Snowdrop {
  const storage = options.storage ?? defaultStorage();
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const cleanups: Unsubscribe[] = [];

  const backends = options.backends ?? new BackendRegistry(BUILTIN_BACKENDS);
  // A stored kind this build doesn't register parses as "not chosen yet".
  const settingsSchema = createSettingsSchema({ isBackendKind: (kind) => backends.has(kind) });
  const stores = createStores({
    settings: loadVersioned(storage, settingsSchema),
    spaces: loadVersioned(storage, spacesSchema),
    local: loadVersioned(storage, localSchema),
  });
  // Drafts change per keystroke: coalesce those writes.
  const debounce = {
    ms: 400,
    schedule: (fn: () => void, ms: number) => scheduler.setTimeout(fn, ms),
  };
  const bindings: PersistenceBinding[] = [
    bindPersistence(stores.settings, storage, settingsSchema, selectSettingsData),
    bindPersistence(stores.spaces, storage, spacesSchema, selectSpacesData),
    bindPersistence(stores.local, storage, localSchema, selectLocalData, debounce),
  ];

  // A plaintext mirror of theme/density (the encrypted-storage bootstrap
  // allow-list, docs/ENCRYPTION.md "Web cache"): the setup/unlock screens
  // can read it straight from storage, before any vault is open, to paint
  // themselves in the user's theme instead of flashing the default one.
  let lastAppearanceBoot: string | undefined;
  const writeAppearanceBoot = (appearance: { themeId: string; density: string }): void => {
    const next = JSON.stringify({ themeId: appearance.themeId, density: appearance.density });
    if (next === lastAppearanceBoot) return;
    lastAppearanceBoot = next;
    storage.setItem(APPEARANCE_BOOT_KEY, next);
  };
  writeAppearanceBoot(stores.settings.getState().appearance);
  cleanups.push(
    stores.settings.subscribe((s, prev) => {
      if (s.appearance !== prev.appearance) writeAppearanceBoot(s.appearance);
    }),
  );

  const reportError = (error: unknown, context: string): void => {
    console.error(`[snowdrop] ${context}`, error);
  };

  // The transport is chosen once per instance; switching means a new instance (a reload).
  const registration = pickBackend(backends, stores.settings.getState().connection.backend);
  const { backend, ready, repository } = connectBackend(
    registration,
    {
      clock,
      scheduler,
      storage,
      connection: stores.settings.getState().connection,
      updateConnection: (patch) => {
        stores.settings.getState().update('connection', patch);
      },
      overrides: {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.mockLatencyMs === undefined ? {} : { mockLatencyMs: options.mockLatencyMs }),
      },
    },
    options.repository,
  );
  // Shared so a receipt that beats the send's acknowledgement isn't lost.
  const receipts = new ReceiptBuffer();

  // Plugin errors outside start/stop (commands, transforms, hover actions…)
  // are logged and recorded on the plugin, so its card shows them with Retry.
  let plugins: PluginRuntime | null = null;
  const registries = new Registries((error, owner, where) => {
    reportError(error, `plugin "${owner}" failed in ${where}`);
    plugins?.reportRuntimeError(owner, error, where);
  });
  const commands = registries.commands;
  const send = new SendService({
    backend,
    repository,
    stores,
    clock,
    pipeline: registries,
    receipts,
    onError: reportError,
  });
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock,
    scheduler,
    receipts,
    onError: reportError,
  });
  const history = new HistoryService({ backend, repository, stores, onError: reportError });

  const host = createPluginHost({
    stores,
    backend,
    send,
    sync,
    onError: (error, pluginId, where) => {
      reportError(error, `plugin "${pluginId}" failed during ${where}`);
    },
  });
  const runtime = new PluginRuntime(host, registries, withUiPlugins(BUILTIN_PLUGINS));
  plugins = runtime;
  const notifications = new NotificationService({
    stores,
    clock,
    api:
      options.notificationApi ?? (isTauri() ? desktopNotificationApi() : browserNotificationApi()),
    source: sync,
    boost: (message) => registries.boostReason(message),
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    focusWindow: () => {
      if (typeof window !== 'undefined') window.focus();
    },
    // Land on the conversation's message list by default (the "Focus the
    // message box when opening a conversation" setting puts it in the composer).
    onOpened: (id) => {
      if (typeof requestAnimationFrame !== 'undefined')
        requestAnimationFrame(() => {
          focusConversation(id, stores.settings.getState().behaviour.focusComposerOnOpen);
        });
    },
  });
  const keybinds = new KeybindDispatcher(
    commands,
    () => stores.settings.getState().keybinds,
    isMacPlatform(),
  );

  registerCoreCommands(commands, stores, sync);

  // Appearance follows settings and plugin styles live.
  const doc = options.document;
  // In the desktop app, links open in the system browser, never in the window.
  if (doc && isTauri()) installDesktopLinks();
  if (doc) {
    const apply = (): void => {
      const s = stores.settings.getState();
      applyAppearance(doc, {
        ...s.appearance,
        customCss: options.safeMode ? '' : s.customCss,
        pluginCss: registries.combinedCss(),
        extraThemes: options.safeMode ? [] : s.customThemes.map(toTheme),
      });
    };
    apply();
    cleanups.push(
      stores.settings.subscribe((s, prev) => {
        if (
          s.appearance !== prev.appearance ||
          s.customCss !== prev.customCss ||
          s.customThemes !== prev.customThemes
        )
          apply();
      }),
      registries.styles.subscribe(apply),
    );
  }

  let started = false;
  const admin: AppAdmin = {
    probeDaemon: async (url) => {
      const { probeDaemon } = await import('@/core/backend/signal-cli');
      return probeDaemon(url, options.fetch ? { fetch: options.fetch } : {});
    },
    exportHistory: (onProgress) => exportHistory(repository, stores, new Date(), onProgress),
    clearHistory: () => repository.clear(),
    flush: () => {
      for (const binding of bindings) binding.flush();
    },
    persist: async () => {
      for (const binding of bindings) binding.flush();
      // An encrypted (hydrated) store writes through asynchronously; moving
      // on before it finishes would lose exactly the change that needed it.
      if (hasPendingWrites(storage)) await storage.flush();
    },
    reload: async (search) => {
      await admin.persist();
      if (search === undefined) window.location.reload();
      else window.location.search = search;
    },
    stopPersistence: () => {
      // Flushes each binding, then unsubscribes it: nothing writes to
      // storage again after this (Settings → Privacy & security, Erase —
      // docs/ENCRYPTION.md, "Erase" — must not let a later debounced write
      // or pagehide flush re-create what was just cleared).
      for (const binding of bindings.splice(0)) binding.dispose();
    },
  };

  return {
    stores,
    backend,
    repository,
    backends,
    registries,
    commands,
    keybinds,
    plugins: runtime,
    sync,
    send,
    history,
    backendReady: ready,
    safeMode: options.safeMode ?? false,
    notifications,
    admin,
    desktop: isTauri() ? desktopAdmin() : null,
    storageAdmin: isTauri() ? desktopStorageAdmin() : null,

    async start() {
      if (started) return;
      // A failure (e.g. signal-cli has no account yet) leaves `started` false so a retry runs everything.
      await sync.start();
      await send.restoreOutbox();
      // sync.start() connected, so the adapter has loaded.
      const loaded = await ready;
      registration.onStarted?.(loaded, { stores });
      await runtime.startAll();
      notifications.start();
      started = true;
      if (registration.attach) cleanups.push(registration.attach(loaded, { stores }));
    },

    flush() {
      for (const binding of bindings) binding.flush();
    },

    async dispose() {
      for (const off of cleanups.splice(0)) off();
      for (const binding of bindings.splice(0)) binding.dispose();
      notifications.stop();
      await runtime.stopAll();
      await sync.stop();
    },
  };
}

/** The registration for the stored choice; the default before the user has chosen. */
function pickBackend(backends: BackendRegistry, chosen: string | null): BackendRegistration {
  const registration = backends.get(chosen ?? DEFAULT_BACKEND) ?? backends.list()[0];
  if (!registration) throw new Error('No backend is registered');
  return registration;
}

/** A storage whose writes complete asynchronously (`HydratedKeyValue`). */
function hasPendingWrites(storage: KeyValueStorage): storage is KeyValueStorage & { flush(): Promise<void> } {
  return typeof (storage as { flush?: unknown }).flush === 'function';
}
