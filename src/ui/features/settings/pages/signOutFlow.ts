/**
 * Signing out (docs/ENCRYPTION.md, "Sign out"; README, "Signing out"): pure
 * so the three flows — and their ordering — are unit-tested without
 * mounting `SignOutDialog`. Which flow applies is read straight off the
 * running backend (`app/backends.ts`), the same way `ConnectionPage` and
 * `EncryptionSection` decide what to show.
 */
import type { AppAdmin, AppServices } from '@/ui/hooks';

/** Which confirm copy and which steps apply. */
export type SignOutFlow =
  /** The demo (`BackendKind` `'mock'`): no account, nothing to disconnect. */
  | 'demo'
  /** signal-cli run by the desktop app itself: Snowdrop owns the vault. */
  | 'desktop'
  /** signal-cli through an external daemon (the browser build, or the desktop app pointed at one Snowdrop doesn't manage): Snowdrop owns none of that daemon's data. */
  | 'browser';

/** Decides the flow from what's actually running, not from an unapplied Settings → Connection edit. */
export function signOutFlowFor(app: Pick<AppServices, 'backend' | 'storageAdmin'>): SignOutFlow {
  if (app.backend.kind !== 'signal-cli') return 'demo';
  return app.storageAdmin ? 'desktop' : 'browser';
}

type ReloadApp = Pick<AppServices, 'stores' | 'admin'>;

/**
 * "Leave demo" (no scary dialog, at most a light confirm): back to the
 * Welcome screen, settings kept. The demo's history is never persisted —
 * `backends.ts` registers it with `history: { kind: 'memory' }`, not an
 * IndexedDB name — so unlike signal-cli's it is never shared with a real
 * backend, and there is nothing to explicitly clear: the reload this
 * triggers already discards it along with the rest of the JS runtime.
 */
export async function leaveDemo(app: ReloadApp): Promise<void> {
  app.stores.settings.getState().update('connection', { backend: null });
  // Awaits the encrypted settings write before reloading (AppAdmin.reload).
  await app.admin.reload();
}

/**
 * "Disconnect" from an external signal-cli daemon: back to the Welcome
 * screen, settings kept. Snowdrop never owned that daemon's data, so
 * nothing about it changes here — only the dialog's copy says so.
 */
export async function disconnectExternalDaemon(app: ReloadApp): Promise<void> {
  app.stores.settings.getState().update('connection', { backend: null });
  await app.admin.reload();
}

type DesktopSignOutApp = Pick<AppServices, 'stores' | 'storageAdmin'> & {
  admin: Pick<AppAdmin, 'clearHistory' | 'persist'>;
};

/**
 * "Sign out" of signal-cli run by the desktop app itself (docs/ENCRYPTION.md,
 * "Sign out"). Order matters:
 *
 * 1. the message cache is cleared first, so a reload that somehow lands
 *    mid-flow can never show a stale account's messages under the demo or a
 *    later account;
 * 2. only then is the backend/account choice cleared (Settings → Connection
 *    reads `connection.account` too, and must not show the old one);
 * 3. settings are flushed to encrypted storage and awaited — they must
 *    survive the restart `storageAdmin.signOut()` requires;
 * 4. `storageAdmin.signOut()` removes this computer's signal-cli vault,
 *    keeping `keys.json` and the keyring entry so storage stays set up;
 * 5. `storageAdmin.restart()` — the vault bridge and the single-instance
 *    lock are one-shot per process, so nothing it did takes effect for this
 *    process until a fresh one starts.
 */
export async function signOutDesktop(app: DesktopSignOutApp): Promise<void> {
  const { storageAdmin } = app;
  if (!storageAdmin) throw new Error('signOutDesktop requires the desktop storage admin.');
  await app.admin.clearHistory();
  app.stores.settings.getState().update('connection', { backend: null, account: null });
  await app.admin.persist();
  await storageAdmin.signOut();
  await storageAdmin.restart();
}
