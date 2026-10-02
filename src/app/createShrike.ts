/**
 * Composition root: the only place that knows which concrete backend,
 * repository and plugins are in use. Everything else receives its
 * dependencies explicitly, which keeps core/ testable and adapters swappable.
 */
import type { ChatBackend } from '@/core/backend';
// Type-only: the adapters themselves are loaded on demand (one chunk each).
import type { MockBackend } from '@/core/backend/mock';
import type { FetchLike } from '@/core/backend/signal-cli';
import {
  type CommandRegistry,
  CoreCommand,
  DEFAULT_KEYBINDS,
  isMacPlatform,
  KeybindDispatcher,
} from '@/core/commands';
import {
  systemClock,
  systemScheduler,
  type Clock,
  type Scheduler,
  type Unsubscribe,
} from '@/core/lib';
import {
  bindPersistence,
  defaultStorage,
  type PersistenceBinding,
  IdbMessageRepository,
  loadVersioned,
  MemoryMessageRepository,
  type KeyValueStorage,
  type MessageRepository,
} from '@/core/persistence';
import { BUILTIN_PLUGINS, PluginRuntime, Registries, type PluginHost } from '@/core/plugins';
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
  createStores,
  localSchema,
  selectLocalData,
  selectSettingsData,
  selectSpacesData,
  settingsSchema,
  spacesSchema,
  uiSelectors,
  type Stores,
} from '@/core/stores';
import { applyAppearance, toTheme, type ThemeDocument } from '@/core/themes';
import type { AppAdmin } from '@/ui/hooks';
import { withUiPlugins } from '@/ui/plugins';
import { deferredBackend } from './deferredBackend';
import { deferredRepository } from './deferredRepository';

export interface ShrikeOptions {
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
  /** Desktop notifications (tests inject a fake); defaults to the browser's. */
  notificationApi?: NotificationApi;
}

export interface Shrike {
  stores: Stores;
  backend: ChatBackend;
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
  /** Connects, syncs and starts plugins. Safe to call again after a failed start (retry). */
  start(): Promise<void>;
  /** Writes debounced persisted state now (call on page hide). */
  flush(): void;
  dispose(): Promise<void>;
}

interface BackendChoice {
  /** Usable immediately; forwards to the adapter once its chunk has loaded. */
  backend: ChatBackend;
  ready: Promise<ChatBackend>;
  repository: MessageRepository;
  /** Set only for the demo, which has extra knobs (liveliness, seeded spaces). */
  mock: Promise<MockBackend> | null;
}

/**
 * Picks the transport from settings. The choice is made once per Shrike
 * instance; switching backends means creating a new instance.
 * - mock (also before the user has chosen): in-memory history, because the
 *   demo world is regenerated each launch relative to "now" and persisting it
 *   would mix timelines.
 * - signal-cli: IndexedDB history, since the daemon keeps none.
 */
function createBackend(
  options: ShrikeOptions,
  stores: Stores,
  storage: KeyValueStorage,
  clock: Clock,
  scheduler: Scheduler,
): BackendChoice {
  const connection = stores.settings.getState().connection;
  if (connection.backend === 'signal-cli') {
    const ready = import('@/core/backend/signal-cli').then(
      ({ SignalCliBackend }) =>
        new SignalCliBackend({
          baseUrl: connection.daemonUrl,
          account: connection.account,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          clock,
          scheduler,
          storage,
          onAccountSelected: (account) => {
            if (stores.settings.getState().connection.account !== account) {
              stores.settings.getState().update('connection', { account });
            }
          },
        }),
    );
    const repository =
      options.repository ??
      (typeof indexedDB === 'undefined'
        ? new MemoryMessageRepository()
        : deferredRepository(IdbMessageRepository.open('shrike-signal-cli')));
    return { backend: deferredBackend('signal-cli', ready), ready, repository, mock: null };
  }
  const mock = import('@/core/backend/mock').then(
    ({ MockBackend }) =>
      new MockBackend({ clock, scheduler, latencyMs: options.mockLatencyMs ?? 120 }),
  );
  return {
    backend: deferredBackend('mock', mock),
    ready: mock,
    repository: options.repository ?? new MemoryMessageRepository(),
    mock,
  };
}

export function createShrike(options: ShrikeOptions = {}): Shrike {
  const storage = options.storage ?? defaultStorage();
  const clock = options.clock ?? systemClock;
  const scheduler = options.scheduler ?? systemScheduler;
  const cleanups: Unsubscribe[] = [];

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

  const reportError = (error: unknown, context: string): void => {
    console.error(`[shrike] ${context}`, error);
  };

  const {
    backend,
    ready,
    repository,
    mock: mockReady,
  } = createBackend(options, stores, storage, clock, scheduler);
  // The loaded demo backend, for the synchronous liveliness toggle.
  let mock: MockBackend | null = null;
  void mockReady?.then(
    (m) => {
      mock = m;
    },
    () => undefined,
  );
  // Shared so a receipt that beats the send's acknowledgement isn't lost.
  const receipts = new ReceiptBuffer();

  const registries = new Registries((error, owner, where) => {
    reportError(error, `plugin "${owner}" failed in ${where}`);
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

  const host: PluginHost = {
    stores,
    backend: {
      kind: backend.kind,
      status: () => backend.getStatus(),
      sendText: async (conversationId, text) => {
        await send.send({ conversationId, text, mentionIds: [], attachments: [] });
      },
      onMessage: (fn) => sync.on('message', fn),
    },
    toast: (message, kind, source) => {
      stores.ui.getState().pushToast({ message, kind, source });
    },
    onError: (error, pluginId, where) => {
      reportError(error, `plugin "${pluginId}" failed during ${where}`);
    },
  };
  const plugins = new PluginRuntime(host, registries, withUiPlugins(BUILTIN_PLUGINS));
  const notifications = new NotificationService({
    stores,
    clock,
    api: options.notificationApi ?? browserNotificationApi(),
    source: sync,
    boost: (message) => registries.boostReason(message),
    isVisible: () => typeof document === 'undefined' || document.visibilityState === 'visible',
    focusWindow: () => {
      if (typeof window !== 'undefined') window.focus();
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
  if (doc) {
    const apply = (): void => {
      const s = stores.settings.getState();
      applyAppearance(doc, {
        ...s.appearance,
        quickCss: s.quickCss,
        pluginCss: registries.combinedCss(),
        extraThemes: s.customThemes.map(toTheme),
      });
    };
    apply();
    cleanups.push(
      stores.settings.subscribe((s, prev) => {
        if (
          s.appearance !== prev.appearance ||
          s.quickCss !== prev.quickCss ||
          s.customThemes !== prev.customThemes
        )
          apply();
      }),
      registries.styles.subscribe(apply),
    );
  }

  const syncLiveliness = (): void => {
    const on = stores.settings.getState().connection.mockLiveliness;
    if (!mock) return;
    if (on && backend.getStatus() === 'online') mock.liveliness.start();
    else mock.liveliness.stop();
  };

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
  };

  return {
    stores,
    backend,
    repository,
    registries,
    commands,
    keybinds,
    plugins,
    sync,
    send,
    history,
    backendReady: ready,
    notifications,
    admin,

    async start() {
      if (started) return;
      // A failure (e.g. signal-cli has no account yet) leaves `started` false so a retry runs everything.
      await sync.start();
      await send.restoreOutbox();
      if (mockReady) {
        const demo = await mockReady;
        // Demo-only defaults so the Discord-like structure is visible on first run.
        // Never applied to a real account, and never re-applied after the user changes them.
        stores.spaces.getState().seedDefaults(demo.world.defaultSpaces);
        stores.local.getState().seedDefaults(demo.world.defaultLocal);
      }
      await plugins.startAll();
      notifications.start();
      started = true;
      syncLiveliness();
      cleanups.push(
        stores.settings.subscribe((s, prev) => {
          if (s.connection !== prev.connection) syncLiveliness();
        }),
        backend.on('status', syncLiveliness),
      );
    },

    flush() {
      for (const binding of bindings) binding.flush();
    },

    async dispose() {
      for (const off of cleanups.splice(0)) off();
      for (const binding of bindings.splice(0)) binding.dispose();
      mock?.liveliness.stop();
      notifications.stop();
      await plugins.stopAll();
      await sync.stop();
    },
  };
}

/**
 * Core commands that can run headless today. The rest (conversation
 * navigation, search, jump to present) need view state that arrives with
 * the P2/P3 UI and will be registered there against the same ids.
 */
function registerCoreCommands(commands: CommandRegistry, stores: Stores, sync: SyncService): void {
  const ui = () => stores.ui.getState();
  commands.register({
    id: CoreCommand.QuickSwitcher,
    title: 'Open quick switcher',
    category: 'Navigation',
    keybind: DEFAULT_KEYBINDS[CoreCommand.QuickSwitcher],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'switcher' });
    },
  });
  commands.register({
    id: CoreCommand.ToggleMemberList,
    title: 'Toggle member list',
    category: 'View',
    keybind: DEFAULT_KEYBINDS[CoreCommand.ToggleMemberList],
    allowInInputs: true,
    run: () => {
      ui().toggleMemberList();
    },
  });
  commands.register({
    id: CoreCommand.OpenSettings,
    title: 'Open settings',
    category: 'App',
    keybind: DEFAULT_KEYBINDS[CoreCommand.OpenSettings],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'settings' });
    },
  });
  commands.register({
    id: CoreCommand.ShortcutHelp,
    title: 'Keyboard shortcuts',
    category: 'App',
    keybind: DEFAULT_KEYBINDS[CoreCommand.ShortcutHelp],
    allowInInputs: true,
    run: () => {
      ui().openModal({ type: 'shortcuts' });
    },
  });
  // Palette-only actions (no default keys; bindable in Settings → Keybinds).
  const settings = () => stores.settings.getState();
  commands.register({
    id: 'core.createSpace',
    title: 'Create a space',
    category: 'Spaces',
    run: () => {
      ui().openModal({ type: 'createSpace' });
    },
  });
  commands.register({
    id: 'core.toggleDensity',
    title: 'Toggle compact mode',
    category: 'View',
    run: () => {
      const density = settings().appearance.density === 'compact' ? 'comfortable' : 'compact';
      settings().update('appearance', { density });
    },
  });
  commands.register({
    id: 'core.toggleNotifications',
    title: 'Toggle desktop notifications',
    category: 'App',
    run: () => {
      settings().update('notifications', { enabled: !settings().notifications.enabled });
    },
  });
  for (const [page, title] of [
    ['plugins', 'Open plugins'],
    ['themes', 'Open themes'],
    ['appearance', 'Open appearance settings'],
    ['keybinds', 'Edit keyboard shortcuts'],
  ] as const) {
    commands.register({
      id: `core.settings.${page}`,
      title,
      category: 'App',
      run: () => {
        ui().openModal({ type: 'settings', props: { page } });
      },
    });
  }
  commands.register({
    id: CoreCommand.MarkRead,
    title: 'Mark conversation as read',
    category: 'Conversation',
    keybind: DEFAULT_KEYBINDS[CoreCommand.MarkRead],
    enabled: () => uiSelectors.selectedConversation(ui()) !== null,
    run: async () => {
      const id = uiSelectors.selectedConversation(ui());
      if (id) await sync.markConversationRead(id);
    },
  });
}
