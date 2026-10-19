/**
 * Composition root: the only place that knows which concrete backend,
 * repository and plugins are in use. Everything else receives its
 * dependencies explicitly, which keeps core/ testable and adapters swappable.
 * Transports are registered in `backends.ts`, the plugin host's services are
 * in `pluginHost.ts` and the headless core commands in `coreCommands.ts`.
 */
import type { ChatBackend, DesktopAdmin, OutgoingLinkPreview, StorageAdmin } from '@/core/backend';
// Type-only: the adapter itself is loaded on demand (its own chunk).
import type { FetchLike } from '@/core/backend/signal-cli';
import { type CommandRegistry, isMacPlatform, KeybindDispatcher } from '@/core/commands';
import type { ConversationId } from '@/core/domain';
import {
  createLogger,
  systemClock,
  systemScheduler,
  type Clock,
  type LogAdmin,
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
  HistoryImportService,
  HistoryService,
  NotificationService,
  PendingOpsBuffer,
  ReceiptBuffer,
  SendService,
  SyncService,
  type NotificationApi,
} from '@/core/services';
import {
  createSettingsSchema,
  createStores,
  localSchema,
  mergeLocalData,
  mergeSpacesData,
  selectLocalData,
  selectSettingsData,
  selectSpacesData,
  spacesSchema,
  totalUnread,
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
import { migrateLegacyScope, rebindScopedStore, scopedSchema, scopeFor } from './dataScope';
import { installStallDetector } from './perf';
import { createPluginHost } from './pluginHost';
import { registerCoreStatusItems } from './statusItems';
import { UnreadSync } from './unreadSync';
import {
  desktopAdmin,
  desktopLogAdmin,
  desktopLinkPreviewFetch,
  desktopNotificationApi,
  desktopClipboardFiles,
  desktopSetCloseToTray,
  desktopSetUnread,
  desktopStorageAdmin,
  installDesktopLinks,
  isTauri,
} from './platform';

/**
 * A plaintext-named, but storage-encrypted (it goes through the same
 * `storage` every other persisted key does — see `HydratedKeyValue`), flag
 * set when sign-out's `clearHistory()` fails after the vault has already
 * been signed out of (docs/ENCRYPTION.md, "Sign out"): the next boot unlocks
 * with the same key, so the old account's cache would otherwise survive.
 * `start()` below honours it before connecting.
 */
const PENDING_HISTORY_CLEAR_KEY = 'snowdrop.pendingHistoryClear';

export interface SnowdropOptions {
  storage?: KeyValueStorage;
  /** Where themes are applied; omit for headless use (tests). */
  document?: ThemeDocument;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Mock network latency in ms. */
  mockLatencyMs?: number;
  /** Scroll-performance harness only (`?mockBulkMessages=`): see `MockBackendOptions.bulkMessages`. */
  mockBulkMessages?: number;
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
  /** The one-time background import of the whole history archive (Settings → Data & storage). */
  historyImport: HistoryImportService;
  /** Resolves with the concrete adapter once its chunk has loaded (dev tools, tests). */
  backendReady: Promise<ChatBackend>;
  notifications: NotificationService;
  /** Gesture-triggered native paste fallback; null in browsers. */
  readClipboardFiles: (() => Promise<File[]>) | null;
  /** Settings → Behaviour → "Link previews" (desktop only); null in browsers. */
  linkPreviewFetch: ((url: string) => Promise<OutgoingLinkPreview | undefined>) | null;
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
  /** Settings → Data & storage → Diagnostics (the on-disk log + verbose floor); null in the browser. */
  logs: LogAdmin | null;
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
  const settings = loadVersioned(storage, settingsSchema);

  // Spaces and local state (core/stores/spaces.ts, core/stores/local.ts) are
  // scoped per backend/account (src/app/dataScope.ts): the demo seeds its
  // own example spaces, and without scoping they — and anything the user
  // did locally while trying it out — would reappear under a real signal-cli
  // account once connected (and vice versa). The registration, not the
  // stored `connection.backend`, decides the scope: an unregistered kind
  // falls back to the demo (`pickBackend`), and the scope must match.
  // `connection.account` is set once signal-cli reports it; `desktop.account`
  // (the spawn-mode `-a` flag) is a usable hint before that, in the common
  // case where it's already configured to the account that will connect.
  const registration = pickBackend(backends, settings.connection.backend);
  let currentScope = scopeFor(
    registration.kind,
    settings.connection.account ?? (settings.connection.desktop.account || null),
  );
  // Runs once: moves data written before scoping existed to the right scope.
  migrateLegacyScope(storage, spacesSchema, currentScope, mergeSpacesData);
  migrateLegacyScope(storage, localSchema, currentScope, mergeLocalData);

  const stores = createStores({
    settings,
    spaces: loadVersioned(storage, scopedSchema(spacesSchema, currentScope)),
    local: loadVersioned(storage, scopedSchema(localSchema, currentScope)),
  });
  // Drafts change per keystroke: coalesce those writes.
  const debounce = {
    ms: 400,
    schedule: (fn: () => void, ms: number) => scheduler.setTimeout(fn, ms),
  };
  const settingsBinding = bindPersistence(
    stores.settings,
    storage,
    settingsSchema,
    selectSettingsData,
  );
  let spacesBinding = bindPersistence(
    stores.spaces,
    storage,
    scopedSchema(spacesSchema, currentScope),
    selectSpacesData,
  );
  let localBinding = bindPersistence(
    stores.local,
    storage,
    scopedSchema(localSchema, currentScope),
    selectLocalData,
    debounce,
  );
  // Replaced wholesale by `rebindToAccount` below when a signal-cli account
  // becomes known after boot; `currentBindings()` always reads whichever
  // binding is current, so admin.flush/persist/stopPersistence need no
  // special-casing for that.
  let persistenceStopped = false;
  const currentBindings = (): PersistenceBinding[] => [
    settingsBinding,
    spacesBinding,
    localBinding,
  ];

  /**
   * Runtime account discovery: signal-cli reports the account asynchronously
   * (`onAccountSelected` in app/backends.ts), which can be after spaces/local
   * were already loaded under a pending placeholder scope (`dataScope.ts`).
   * When that happens, this moves their persistence to the account's own
   * scope, folding in anything written under the placeholder in the
   * meantime rather than losing it (`rebindScopedStore`'s doc comment has
   * the merge rule). A no-op if the account matches the scope already in
   * use (e.g. `desktop.account` already hinted it correctly at boot).
   */
  const rebindToAccount = (accountId: string): void => {
    if (persistenceStopped) return;
    const nextScope = scopeFor(registration.kind, accountId);
    if (nextScope === currentScope) return;
    const previousScope = currentScope;
    currentScope = nextScope;
    spacesBinding = rebindScopedStore({
      store: stores.spaces,
      storage,
      schema: spacesSchema,
      select: selectSpacesData,
      scope: nextScope,
      previousScope,
      merge: mergeSpacesData,
    });
    localBinding = rebindScopedStore({
      store: stores.local,
      storage,
      schema: localSchema,
      select: selectLocalData,
      scope: nextScope,
      previousScope,
      merge: mergeLocalData,
      debounce,
    });
  };

  // A plaintext mirror of theme/density (the encrypted-storage bootstrap
  // allow-list, docs/ENCRYPTION.md "Web cache"): the setup/unlock screens
  // can read it straight from storage, before any vault is open, to paint
  // themselves in the user's theme instead of flashing the default one.
  let lastAppearanceBoot: string | undefined;
  const writeAppearanceBoot = (appearance: {
    themeId: string;
    density: string;
    shell: string;
  }): void => {
    const next = JSON.stringify({
      themeId: appearance.themeId,
      density: appearance.density,
      shell: appearance.shell,
    });
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

  // Settings → Data & storage → Diagnostics: desktop-only (null in the
  // browser, where there's no on-disk log or Rust-side verbose floor).
  const logs: LogAdmin | null = isTauri() ? desktopLogAdmin() : null;
  // Applied at boot with whatever was persisted, and again on every change
  // below — covers a toggle from the Diagnostics page as well as settings
  // arriving from an import or a reset.
  void logs?.setVerbose(stores.settings.getState().behaviour.verboseLogging);
  cleanups.push(
    stores.settings.subscribe((s, prev) => {
      if (s.behaviour.verboseLogging !== prev.behaviour.verboseLogging)
        void logs?.setVerbose(s.behaviour.verboseLogging);
    }),
  );

  // Tray badge, taskbar/dock badge and window title (desktop only;
  // src-tauri/src/tray.rs). `unreadSync` debounces and only sends on
  // change; `totalUnread` is the same total the TUI shell's own status
  // line uses (muted chats excluded — core/stores/views.ts).
  if (isTauri()) {
    const unreadSync = new UnreadSync(
      scheduler,
      () => {
        const { unread, byId } = stores.conversations.getState();
        const local = stores.local.getState().conversations;
        return totalUnread(unread, local, Object.keys(byId) as ConversationId[], clock.now());
      },
      ({ count, mentions }) => {
        desktopSetUnread(count, mentions);
      },
    );
    unreadSync.flush();
    cleanups.push(
      stores.conversations.subscribe((s, prev) => {
        if (s.unread !== prev.unread || s.byId !== prev.byId) unreadSync.notify();
      }),
      stores.local.subscribe((s, prev) => {
        if (s.conversations !== prev.conversations) unreadSync.notify();
      }),
      () => {
        unreadSync.dispose();
      },
    );

    // Mirrors Settings → Behaviour's "Keep running in the tray" into Rust,
    // which decides hide-vs-quit at the main window's close — Rust has no
    // access to this store itself.
    desktopSetCloseToTray(stores.settings.getState().behaviour.closeToTray);
    cleanups.push(
      stores.settings.subscribe((s, prev) => {
        if (s.behaviour.closeToTray !== prev.behaviour.closeToTray)
          desktopSetCloseToTray(s.behaviour.closeToTray);
      }),
    );
  }

  const appLog = createLogger('app');
  const reportError = (error: unknown, context: string): void => {
    appLog.error(context, error);
  };

  // The transport is chosen once per instance; switching means a new instance
  // (a reload) — `registration` was already resolved above, to pick spaces/
  // local's initial scope before loading them.
  const { backend, ready, repository } = connectBackend(
    registration,
    {
      clock,
      scheduler,
      storage,
      connection: stores.settings.getState().connection,
      updateConnection: (patch) => {
        stores.settings.getState().update('connection', patch);
        // The only patch signal-cli sends through here is the account it
        // discovered (`onAccountSelected`); rebind spaces/local to it.
        if (patch.account) rebindToAccount(patch.account);
      },
      overrides: {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.mockLatencyMs === undefined ? {} : { mockLatencyMs: options.mockLatencyMs }),
        ...(options.mockBulkMessages === undefined
          ? {}
          : { mockBulkMessages: options.mockBulkMessages }),
      },
    },
    options.repository,
  );
  // Shared so a receipt, or a delete/reaction/edit/pin, that beats the send's
  // acknowledgement isn't lost.
  const receipts = new ReceiptBuffer();
  const pendingOps = new PendingOpsBuffer();

  // Per-concern scopes (Settings → Diagnostics): send/sync/history errors
  // land under their own `ui:<scope>`, separate from the generic `app` one
  // `reportError`/`consoleReporter` use.
  const sendLog = createLogger('send');
  const syncLog = createLogger('sync');
  const historyLog = createLogger('history');
  const historyImportLog = createLogger('history-import');

  // Plugin errors outside start/stop (commands, transforms, hover actions…)
  // are logged under `plugins:<id>` and recorded on the plugin, so its card
  // shows them with Retry.
  let plugins: PluginRuntime | null = null;
  const registries = new Registries((error, owner, where) => {
    createLogger(`plugins:${owner}`).error(`failed in ${where}`, error);
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
    pendingOps,
    onError: (error, context) => {
      sendLog.error(context, error);
    },
  });
  const sync = new SyncService({
    backend,
    repository,
    stores,
    clock,
    scheduler,
    receipts,
    pendingOps,
    onError: (error, context) => {
      syncLog.error(context, error);
    },
  });
  const history = new HistoryService({
    backend,
    repository,
    stores,
    onError: (error, context) => {
      historyLog.error(context, error);
    },
  });
  const historyImport = new HistoryImportService({
    backend,
    repository,
    stores,
    storage,
    // Same scoping as spaces/local (app/dataScope.ts): per backend/account,
    // so switching accounts can never resume a different account's import.
    scope: () => {
      const connection = stores.settings.getState().connection;
      return scopeFor(
        registration.kind,
        connection.account ?? (connection.desktop.account || null),
      );
    },
    clock,
    scheduler,
    onError: (error, context) => {
      historyImportLog.error(context, error);
    },
  });

  const host = createPluginHost({
    stores,
    backend,
    send,
    sync,
    onError: (error, pluginId, where) => {
      createLogger(`plugins:${pluginId}`).error(`failed during ${where}`, error);
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
  cleanups.push(...registerCoreStatusItems(registries, stores));

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
    // Freeze diagnostics: watches for a stalled main thread. Only with a
    // real `document` — never in headless tests — covering desktop and
    // browser alike.
    cleanups.push(installStallDetector(stores));
  }

  let started = false;
  const admin: AppAdmin = {
    probeDaemon: async (url) => {
      const { probeDaemon } = await import('@/core/backend/signal-cli');
      return probeDaemon(url, options.fetch ? { fetch: options.fetch } : {});
    },
    exportHistory: (onProgress) => exportHistory(repository, stores, new Date(), onProgress),
    clearHistory: async () => {
      await repository.clear();
      // The archive is still on signal-cli; clearing our copy re-allows a
      // full import instead of leaving it stuck at "done" against an empty
      // repository.
      historyImport.reset();
    },
    disconnect: () => sync.stop(),
    setPendingHistoryClear: async (pending) => {
      if (pending) storage.setItem(PENDING_HISTORY_CLEAR_KEY, '1');
      else storage.removeItem(PENDING_HISTORY_CLEAR_KEY);
      if (hasPendingWrites(storage)) await storage.flush();
    },
    flush: () => {
      for (const binding of currentBindings()) binding.flush();
    },
    persist: async () => {
      for (const binding of currentBindings()) binding.flush();
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
      // or pagehide flush re-create what was just cleared). Also stops a
      // later `rebindToAccount` from creating a fresh binding.
      persistenceStopped = true;
      for (const binding of currentBindings()) binding.dispose();
    },
    syncContactsAndGroups: async () => {
      // Optional capability: backends without an equivalent (the mock) just
      // don't implement it. The resulting contacts/groups land through the
      // adapter's own conversationUpdated/contactUpdated events, which
      // SyncService already turns into store updates — nothing further to
      // do here.
      await backend.syncContactsAndGroups?.();
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
    historyImport,
    backendReady: ready,
    safeMode: options.safeMode ?? false,
    notifications,
    readClipboardFiles: isTauri() ? desktopClipboardFiles : null,
    linkPreviewFetch: isTauri() ? desktopLinkPreviewFetch : null,
    admin,
    desktop: isTauri() ? desktopAdmin() : null,
    storageAdmin: isTauri() ? desktopStorageAdmin() : null,
    logs,

    async start() {
      if (started) return;
      // Sign-out (signOutFlow.ts) sets this when its own `clearHistory()`
      // failed after the vault was already signed out of: honour it now,
      // before connecting, so the previous account's cache is never shown
      // under whatever runs next. Left set (and retried next boot) if this
      // attempt fails too, rather than blocking boot on it.
      if (storage.getItem(PENDING_HISTORY_CLEAR_KEY) !== null) {
        try {
          await admin.clearHistory();
          await admin.setPendingHistoryClear(false);
        } catch (error) {
          reportError(error, 'retrying a pending history clear from sign-out');
        }
      }
      // A failure (e.g. signal-cli has no account yet) leaves `started` false so a retry runs everything.
      await sync.start();
      // Fire-and-forget: it waits on the session store (ready, not
      // catchingUp) and runs in the background for as long as it takes;
      // nothing here should block on it.
      void historyImport.start();
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
      for (const binding of currentBindings()) binding.flush();
    },

    async dispose() {
      for (const off of cleanups.splice(0)) off();
      persistenceStopped = true;
      for (const binding of currentBindings()) binding.dispose();
      notifications.stop();
      await runtime.stopAll();
      await historyImport.stop();
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
function hasPendingWrites(
  storage: KeyValueStorage,
): storage is KeyValueStorage & { flush(): Promise<void> } {
  return typeof (storage as { flush?: unknown }).flush === 'function';
}
