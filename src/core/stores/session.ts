import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, Contact } from '@/core/domain';

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

  setBackendKind(kind: BackendKind | null): void;
  setStatus(status: ConnectionStatus): void;
  setSelf(self: Contact): void;
  setError(error: string | null, kind?: string | null): void;
  setReady(ready: boolean): void;
  setCatchingUp(catchingUp: boolean): void;
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
};
