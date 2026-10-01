/**
 * The composed app as the React tree sees it. Declared here (not in app/) so
 * features can depend on it without importing the composition root; the
 * concrete `Hearth` from app/createHearth satisfies this structurally.
 */
import { createContext, use, type ReactNode } from 'react';
import type { ChatBackend } from '@/core/backend';
import type { CommandRegistry, KeybindDispatcher } from '@/core/commands';
import type { MessageRepository } from '@/core/persistence';
import type { PluginRuntime, Registries } from '@/core/plugins';
import type { HistoryService, SendService, SyncService } from '@/core/services';
import type { Stores } from '@/core/stores';

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
  backend: Pick<ChatBackend, 'kind' | 'resolveAttachmentUrl'>;
  /** Read-only history queries (search, mentions inbox, pins). */
  repository: Pick<MessageRepository, 'search' | 'mentions' | 'pinned'>;
  /** Connects and syncs; the app calls it once a backend has been chosen. */
  start(): Promise<void>;
}

const HearthContext = createContext<AppServices | null>(null);

export function HearthContextProvider({
  value,
  children,
}: {
  value: AppServices;
  children: ReactNode;
}) {
  return <HearthContext value={value}>{children}</HearthContext>;
}

export function useHearth(): AppServices {
  const hearth = use(HearthContext);
  if (!hearth) throw new Error('useHearth must be used inside <HearthProvider>');
  return hearth;
}

export function useStores(): Stores {
  return useHearth().stores;
}
