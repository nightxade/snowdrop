/**
 * Composition root: the only place that knows which concrete backend,
 * repository and plugins are in use. Everything else receives its
 * dependencies explicitly, which keeps core/ testable and adapters swappable.
 */
import type { ChatBackend } from '@/core/backend';
import { MockBackend } from '@/core/backend/mock';
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
  loadVersioned,
  MemoryMessageRepository,
  type KeyValueStorage,
  type MessageRepository,
} from '@/core/persistence';
import { BUILTIN_PLUGINS, PluginRuntime, Registries, type PluginHost } from '@/core/plugins';
import { HistoryService, ReceiptBuffer, SendService, SyncService } from '@/core/services';
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
import { applyAppearance, type ThemeDocument } from '@/core/themes';

export interface HearthOptions {
  storage?: KeyValueStorage;
  /** Where themes are applied; omit for headless use (tests). */
  document?: ThemeDocument;
  clock?: Clock;
  scheduler?: Scheduler;
  /** Mock network latency in ms. */
  mockLatencyMs?: number;
}

export interface Hearth {
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
  /** Connects, syncs and starts plugins. */
  start(): Promise<void>;
  /** Writes debounced persisted state now (call on page hide). */
  flush(): void;
  dispose(): Promise<void>;
}

export function createHearth(options: HearthOptions = {}): Hearth {
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
    console.error(`[hearth] ${context}`, error);
  };

  // TODO(P5): choose the signal-cli adapter + IdbMessageRepository when
  // settings.connection.backend === 'signal-cli'. The mock regenerates its
  // world each launch, so its history lives in memory only (persisting it
  // would mix timelines from different launches).
  const mock = new MockBackend({ clock, scheduler, latencyMs: options.mockLatencyMs ?? 120 });
  const backend: ChatBackend = mock;
  const repository: MessageRepository = new MemoryMessageRepository();
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
  const plugins = new PluginRuntime(host, registries, BUILTIN_PLUGINS);
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
      });
    };
    apply();
    cleanups.push(
      stores.settings.subscribe((s, prev) => {
        if (s.appearance !== prev.appearance || s.quickCss !== prev.quickCss) apply();
      }),
      registries.styles.subscribe(apply),
    );
  }

  const syncLiveliness = (): void => {
    const on = stores.settings.getState().connection.mockLiveliness;
    if (on && backend.getStatus() === 'online') mock.liveliness.start();
    else mock.liveliness.stop();
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

    async start() {
      await sync.start();
      await send.restoreOutbox();
      if (backend.kind === 'mock') {
        // Demo-only defaults so the Discord-like structure is visible on first run.
        // Never applied to a real account, and never re-applied after the user changes them.
        stores.spaces.getState().seedDefaults(mock.world.defaultSpaces);
        stores.local.getState().seedDefaults(mock.world.defaultLocal);
      }
      await plugins.startAll();
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
      mock.liveliness.stop();
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
