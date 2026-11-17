import { createStore, type StoreApi } from 'zustand/vanilla';
import type { BackendKind } from '@/core/backend';
import type { ConnectionStatus, Contact } from '@/core/domain';
import type { AppError } from '@/core/lib';
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

/**
 * Where the session is, in the one vocabulary the shell routes on:
 *
 * - `idle`: nothing started, or stopped.
 * - `connecting`: the first connect and initial sync are in flight.
 * - `needs-link`: signal-cli has no linked account; run the link flow.
 * - `needs-account`: a single-account daemon that must be told which account.
 * - `not-installed`: no signal-cli program to run (desktop).
 * - `ready`: initial sync done and the connection is online.
 * - `degraded`: initial sync done, the connection is not online right now.
 *   The data is still there; a banner explains the connection.
 * - `failed`: the first connect failed with nothing the user can set up.
 *
 * `error` is the failure behind `needs-*`, `not-installed`, `failed`, and
 * also `degraded` after a failed reconnect.
 */
export type SessionPhase =
  | 'idle'
  | 'connecting'
  | 'needs-link'
  | 'needs-account'
  | 'not-installed'
  | 'ready'
  | 'degraded'
  | 'failed';

/** The phase a failed first connect lands in; only these kinds mean "the user has a setup step". */
export function phaseForConnectError(error: AppError): SessionPhase {
  switch (error.kind) {
    case 'no-account':
      return 'needs-link';
    case 'account-required':
      return 'needs-account';
    case 'not-installed':
      return 'not-installed';
    default:
      return 'failed';
  }
}

/** True once the initial sync has completed (contacts, conversations, unread are loaded). */
export function isSynced(phase: SessionPhase): boolean {
  return phase === 'ready' || phase === 'degraded';
}

export interface SessionState {
  backendKind: BackendKind | null;
  phase: SessionPhase;
  /**
   * The live state of the backend's connection, as it reports it. Orthogonal
   * to `phase`: a retry after a failure shows `connecting` here while the
   * phase (and the screen it routes to) stays put, and `degraded` can be
   * `connecting`, `offline` or `error`. Only the store's own transitions
   * (`setLink`, `markFailed`, ...) write it, together with `phase`.
   */
  link: ConnectionStatus;
  self: Contact | null;
  /** The last connection failure, until the connection comes back. See `SessionPhase`. */
  error: AppError | null;
  /**
   * True while the backend is draining messages queued on the server before
   * this connection (SyncService's CatchUpTracker). The sidebar freezes
   * order/badges and shows "Loading…" previews while this is true.
   */
  catchingUp: boolean;
  /**
   * True while messages processed now are old ones being replayed, so
   * NotificationService must not announce them. Always equal to
   * `catchingUp`: one tracker sets both (SyncService's `catchUp`).
   */
  notificationsHeld: boolean;
  /** See `HistoryImportProgress`. */
  historyImport: HistoryImportProgress;
  /**
   * Latest `attachmentBackfill` event per message (patches/signal-cli,
   * "0014: attachment backfill"), keyed by `${authorId}\u0000${sentAt}` —
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
  /** The backend reported a connection state. */
  setLink(link: ConnectionStatus): void;
  /** A first connect (or a retry of one) is starting. Keeps a failure's screen up while it runs. */
  markConnecting(): void;
  /** The initial sync finished. */
  markSynced(): void;
  /** A connect or reconnect failed. */
  markFailed(error: AppError): void;
  /** The session was stopped. */
  markStopped(): void;
  setSelf(self: Contact): void;
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
    phase: 'idle',
    link: 'offline',
    self: null,
    error: null,
    catchingUp: false,
    notificationsHeld: false,
    historyImport: IDLE_HISTORY_IMPORT,
    attachmentBackfills: {},
    phonePrivacy: initialPhonePrivacy(),
    setBackendKind: (backendKind) => {
      set({ backendKind });
    },
    setLink: (link) => {
      set((s) => {
        if (link === 'online') {
          // Online clears the failure. Before the initial sync that is "connecting"
          // (a retry after a failure moves off the failure's screen here, not earlier).
          return { link, error: null, phase: isSynced(s.phase) ? 'ready' : 'connecting' };
        }
        return { link, phase: s.phase === 'ready' ? 'degraded' : s.phase };
      });
    },
    markConnecting: () => {
      set((s) => (s.phase === 'idle' ? { phase: 'connecting' } : s));
    },
    markSynced: () => {
      set((s) => ({ phase: s.link === 'online' ? 'ready' : 'degraded' }));
    },
    markFailed: (error) => {
      set((s) => ({
        link: 'error',
        error,
        phase: isSynced(s.phase) ? 'degraded' : phaseForConnectError(error),
      }));
    },
    markStopped: () => {
      set({ phase: 'idle', error: null });
    },
    setSelf: (self) => {
      set({ self });
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
  phase: (s: SessionState) => s.phase,
  link: (s: SessionState) => s.link,
  self: (s: SessionState) => s.self,
  selfId: (s: SessionState) => s.self?.id ?? null,
  isOnline: (s: SessionState) => s.link === 'online',
  /** The initial sync has completed (see `isSynced`). */
  ready: (s: SessionState) => isSynced(s.phase),
  error: (s: SessionState) => s.error,
  catchingUp: (s: SessionState) => s.catchingUp,
  notificationsHeld: (s: SessionState) => s.notificationsHeld,
  historyImport: (s: SessionState) => s.historyImport,
  phonePrivacy: (s: SessionState) => s.phonePrivacy,
  attachmentBackfill: (authorId: string, sentAt: number) => (s: SessionState) =>
    s.attachmentBackfills[`${authorId}\u0000${sentAt}`],
};
