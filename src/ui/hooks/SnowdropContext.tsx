/**
 * The composed app as the React tree sees it. Declared here (not in app/) so
 * features can depend on it without importing the composition root; the
 * concrete `Snowdrop` from app/createSnowdrop satisfies this structurally.
 */
import { createContext, use, type ReactNode } from 'react';
import type { BackendOption, ChatBackend, DesktopAdmin } from '@/core/backend';
import type { CommandRegistry, KeybindDispatcher } from '@/core/commands';
import type { MessageRepository } from '@/core/persistence';
import type { PluginRuntime, Registries } from '@/core/plugins';
import type {
  HistoryExport,
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
  /** Writes debounced persisted state now (before a reload). */
  flush(): void;
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
   * The only transport capabilities the UI may touch directly: its kind and
   * lazy attachment URLs (render-only, see ChatBackend.resolveAttachmentUrl).
   * Everything else goes through the services.
   */
  backend: Pick<ChatBackend, 'kind' | 'resolveAttachmentUrl' | 'link'>;
  /** The registered transports (Settings → Connection lists them). */
  backends: { options(): readonly BackendOption[] };
  /** Desktop notification permission + a test notification. */
  notifications: Pick<NotificationService, 'permission' | 'requestPermission' | 'test'>;
  admin: AppAdmin;
  /** The desktop app's signal-cli management (Settings → Connection, About); null in the browser. */
  desktop: DesktopAdmin | null;
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
