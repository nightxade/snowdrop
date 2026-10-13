import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, Contact } from '@/core/domain';

export type HistoryImportStatus = 'idle' | 'importing' | 'done' | 'failed';

/**
 * Progress of `HistoryImportService`'s one-time archive import, for the
 * sidebar footer's indicator and Settings → Data & storage's status line.
 * `percent` is a conversation-weighted estimate (counting whole chats as
 * done, not individual messages) while importing, and 100 once done.
 */
export interface HistoryImportProgress {
  status: HistoryImportStatus;
  percent: number;
  /** Messages written to the repository across this and any earlier runs. */
  imported: number;
  error: string | null;
}

const IDLE_HISTORY_IMPORT: HistoryImportProgress = {
  status: 'idle',
  percent: 0,
  imported: 0,
  error: null,
};

export interface SessionState {
  backendKind: BackendKind | null;
  status: ConnectionStatus;
  self: Contact | null;
  /** Last connection/sync error, user-presentable. */
  error: string | null;
  /**
   * Machine-readable kind of `error` when the transport provides one (e.g.
   * signal-cli's 'no-account' / 'account-required', which start the link flow).
   */
  errorKind: string | null;
  /** True once the initial sync (contacts, conversations, unread) finished. */
  ready: boolean;
  /**
   * True while the backend is draining messages queued on the server before
   * this connection (SyncService's CatchUpTracker). The sidebar freezes
   * order/badges and shows "Loading…" previews while this is true, and
   * NotificationService suppresses notifications for messages processed
   * during it.
   */
  catchingUp: boolean;
  /** See `HistoryImportProgress`. */
  historyImport: HistoryImportProgress;

  setBackendKind(kind: BackendKind | null): void;
  setStatus(status: ConnectionStatus): void;
  setSelf(self: Contact): void;
  setError(error: string | null, kind?: string | null): void;
  setReady(ready: boolean): void;
  setCatchingUp(catchingUp: boolean): void;
  setHistoryImport(patch: Partial<HistoryImportProgress>): void;
}

export type SessionStore = StoreApi<SessionState>;

export function createSessionStore(): SessionStore {
  return createStore<SessionState>()((set) => ({
    backendKind: null,
    status: 'offline',
    self: null,
    error: null,
    errorKind: null,
    ready: false,
    catchingUp: false,
    historyImport: IDLE_HISTORY_IMPORT,
    setBackendKind: (backendKind) => {
      set({ backendKind });
    },
    setStatus: (status) => {
      set(status === 'online' ? { status, error: null, errorKind: null } : { status });
    },
    setSelf: (self) => {
      set({ self });
    },
    setError: (error, kind = null) => {
      set({ error, errorKind: error === null ? null : kind });
    },
    setReady: (ready) => {
      set({ ready });
    },
    setCatchingUp: (catchingUp) => {
      set({ catchingUp });
    },
    setHistoryImport: (patch) => {
      set((s) => ({ historyImport: { ...s.historyImport, ...patch } }));
    },
  }));
}

export const sessionSelectors = {
  status: (s: SessionState) => s.status,
  self: (s: SessionState) => s.self,
  selfId: (s: SessionState) => s.self?.id ?? null,
  isOnline: (s: SessionState) => s.status === 'online',
  ready: (s: SessionState) => s.ready,
  error: (s: SessionState) => s.error,
  errorKind: (s: SessionState) => s.errorKind,
  catchingUp: (s: SessionState) => s.catchingUp,
  historyImport: (s: SessionState) => s.historyImport,
};
