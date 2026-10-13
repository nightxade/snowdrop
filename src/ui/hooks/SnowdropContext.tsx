/**
 * The composed app as the React tree sees it. Declared here (not in app/) so
 * features can depend on it without importing the composition root; the
 * concrete `Snowdrop` from app/createSnowdrop satisfies this structurally.
 */
import { createContext, use, type ReactNode } from 'react';
import type { BackendOption, ChatBackend, DesktopAdmin, StorageAdmin } from '@/core/backend';
import type { CommandRegistry, KeybindDispatcher } from '@/core/commands';
import type { LogAdmin } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { PluginRuntime, Registries } from '@/core/plugins';
import type {
  HistoryExport,
  HistoryImportService,
  HistoryService,
  NotificationService,
  SendService,
  SyncService,
} from '@/core/services';
import type { Stores } from '@/core/stores';

/** Result of Settings → Connection → Test connection. */
export type DaemonProbe =
  { ok: true; accounts: number | null } | { ok: false; kind: string; message: string };

/** App-level maintenance the settings and onboarding screens need. */
export interface AppAdmin {
  /** Checks a signal-cli daemon URL (GET /api/v1/check, then listAccounts). */
  probeDaemon(url: string): Promise<DaemonProbe>;
  /** Everything stored locally, as JSON-serialisable data. */
  exportHistory(onProgress?: (done: number, total: number) => void): Promise<HistoryExport>;
  /** Deletes all stored messages and outbox entries (settings are kept). */
  clearHistory(): Promise<void>;
  /**
   * Stops syncing and disconnects the backend, so nothing from the current
   * account can land in storage after a following `clearHistory()`. Only
   * for flows that reload or restart right after (account switch, sign-out).
   */
  disconnect(): Promise<void>;
  /**
   * Marks (or clears) a flag the next boot honours by clearing history
   * before starting. Set when `clearHistory()` fails partway through
   * sign-out (the vault is already signed out and the next boot unlocks
   * with the same key, so the old account's cache must still go) — cleared
   * once a later `clearHistory()` actually succeeds. Awaiting it guarantees
   * the flag itself reaches storage, even if the process restarts right after.
   */
  setPendingHistoryClear(pending: boolean): Promise<void>;
  /** Writes debounced persisted state now (before a reload). */
  flush(): void;
  /**
   * Flushes and waits until persisted state has actually reached storage
   * (encrypted writes finish asynchronously) — without reloading. Use this
   * when something after the flush (e.g. `storageAdmin.signOut()`) must not
   * start until settings have actually landed.
   */
  persist(): Promise<void>;
  /**
   * `persist()`, then reloads — optionally with a new query string. Use
   * this instead of `location.reload()`.
   */
  reload(search?: string): Promise<void>;
  /** Flushes, then unsubscribes every persistence binding (Settings → Privacy & security, Erase). */
  stopPersistence(): void;
  /**
   * Settings → Connection → "Sync contacts and groups": asks the primary
   * device to resend contacts/groups/the block list, when the backend
   * supports it (signal-cli only). A no-op otherwise, so the caller never
   * needs to check which backend is running.
   */
  syncContactsAndGroups(): Promise<void>;
}

export interface AppServices {
  stores: Stores;
  registries: Registries;
  commands: CommandRegistry;
  keybinds: KeybindDispatcher;
  plugins: PluginRuntime;
  sync: SyncService;
  send: SendService;
  history: HistoryService;
  /**
   * Progress lives in `stores.session.getState().historyImport`; this is
   * only the action Settings' "failed — Retry" needs.
   */
  historyImport: Pick<HistoryImportService, 'retry'>;
  /**
   * The only transport capabilities the UI may touch directly: its kind and
   * lazy attachment URLs (render-only, see ChatBackend.resolveAttachmentUrl).
   * Everything else goes through the services.
   */
  backend: Pick<ChatBackend, 'kind' | 'resolveAttachmentUrl' | 'link'>;
  /** The registered transports (Settings → Connection lists them). */
  backends: { options(): readonly BackendOption[] };
  /** Desktop notification permission + a test notification. */
  notifications: Pick<NotificationService, 'permission' | 'requestPermission' | 'test'>;
  /** Native file/image clipboard fallback, available only in the desktop shell. */
  readClipboardFiles: (() => Promise<File[]>) | null;
  admin: AppAdmin;
  /** The desktop app's signal-cli management (Settings → Connection, About); null in the browser. */
  desktop: DesktopAdmin | null;
  /** Encrypted storage (Settings → Privacy & security, docs/ENCRYPTION.md); null in the browser. */
  storageAdmin: StorageAdmin | null;
  /** Settings → Data & storage → Diagnostics (the on-disk log + verbose floor); null in the browser. */
  logs: LogAdmin | null;
  /** Started in safe mode: imported themes and Custom CSS are not applied. */
  readonly safeMode: boolean;
  /** Read-only history queries (search, mentions inbox, pins). */
  repository: Pick<MessageRepository, 'search' | 'mentions' | 'pinned'>;
  /** Connects and syncs; the app calls it once a backend has been chosen. */
  start(): Promise<void>;
}

const SnowdropContext = createContext<AppServices | null>(null);

export function SnowdropContextProvider({
  value,
  children,
}: {
  value: AppServices;
  children: ReactNode;
}) {
  return <SnowdropContext value={value}>{children}</SnowdropContext>;
}

export function useSnowdrop(): AppServices {
  const snowdrop = use(SnowdropContext);
  if (!snowdrop) throw new Error('useSnowdrop must be used inside <SnowdropProvider>');
  return snowdrop;
}

export function useStores(): Stores {
  return useSnowdrop().stores;
}
