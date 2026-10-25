import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, Contact } from '@/core/domain';
import { initialPhonePrivacy, type PhonePrivacyState } from './privacy';

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
   * order/badges and shows "Loading…" previews while this is true.
   */
  catchingUp: boolean;
  /**
   * True while messages processed now are old ones being replayed, so
   * NotificationService must not announce them. It starts and ends with
   * `catchingUp`, except that with a backend that reliably sends `caughtUp`
   * it outlasts `catchingUp`'s short ceiling (see `NOTIFICATION_HOLD_CEILING_MS`).
   */
  notificationsHeld: boolean;
  /** See `HistoryImportProgress`. */
  historyImport: HistoryImportProgress;
  /**
   * Latest `attachmentBackfill` event per message (patches/signal-cli,
   * "0016: attachment backfill"), keyed by `${authorId}\u0000${sentAt}` —
   * read by `useAttachmentUrl` to drive the "Getting it from your
   * phone…" / retry UI. Ephemeral (session-only): a restart shows the
   * attachment's plain failure state instead, with a manual retry.
   */
  attachmentBackfills: Record<string, AttachmentBackfillStatus>;
  /**
   * The privacy settings the user's phone syncs to this device and whether
   * they're known yet (see `effectivePrivacy`). Session-only: re-read on
   * every connect, never persisted.
   */
  phonePrivacy: PhonePrivacyState;

  setBackendKind(kind: BackendKind | null): void;
  setStatus(status: ConnectionStatus): void;
  setSelf(self: Contact): void;
  setError(error: string | null, kind?: string | null): void;
  setReady(ready: boolean): void;
  setCatchingUp(catchingUp: boolean): void;
  setNotificationsHeld(held: boolean): void;
  setHistoryImport(patch: Partial<HistoryImportProgress>): void;
  setAttachmentBackfill(key: string, status: AttachmentBackfillStatus): void;
  setPhonePrivacy(phonePrivacy: PhonePrivacyState): void;
  /** Call right before sending a new request for `key`, so a stale answer from an earlier one can't leak into it. */
  clearAttachmentBackfill(key: string): void;
}

export interface AttachmentBackfillStatus {
  status: 'pending' | 'ready' | 'failed';
  attachmentIds: readonly string[];
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
    notificationsHeld: false,
    historyImport: IDLE_HISTORY_IMPORT,
    attachmentBackfills: {},
    phonePrivacy: initialPhonePrivacy(),
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
    setNotificationsHeld: (notificationsHeld) => {
      set({ notificationsHeld });
    },
    setHistoryImport: (patch) => {
      set((s) => ({ historyImport: { ...s.historyImport, ...patch } }));
    },
    setAttachmentBackfill: (key, status) => {
      set((s) => ({ attachmentBackfills: { ...s.attachmentBackfills, [key]: status } }));
    },
    setPhonePrivacy: (phonePrivacy) => {
      set({ phonePrivacy });
    },
    clearAttachmentBackfill: (key) => {
      set((s) => {
        const { [key]: _removed, ...rest } = s.attachmentBackfills;
        return { attachmentBackfills: rest };
      });
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
  notificationsHeld: (s: SessionState) => s.notificationsHeld,
  historyImport: (s: SessionState) => s.historyImport,
  phonePrivacy: (s: SessionState) => s.phonePrivacy,
  attachmentBackfill: (authorId: string, sentAt: number) => (s: SessionState) =>
    s.attachmentBackfills[`${authorId}\u0000${sentAt}`],
};
