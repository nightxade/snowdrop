/**
 * Signing out (docs/ENCRYPTION.md, "Sign out"; README, "Signing out"): pure
 * so the three flows — and their ordering — are unit-tested without
 * mounting `SignOutDialog`. Which flow applies is read straight off the
 * running backend (`app/backends.ts`), the same way `ConnectionPage` and
 * `EncryptionSection` decide what to show.
 */
import { describeFailure } from '@/ui/lib/connectionErrors';
import { createLogger } from '@/core/lib';
import type { AppAdmin, AppServices } from '@/ui/hooks';

const log = createLogger('app');

/** Which confirm copy and which steps apply. */
export type SignOutFlow =
  /** The demo (`BackendKind` `'mock'`): no account, nothing to disconnect. */
  | 'demo'
  /** signal-cli run by the desktop app itself: Snowdrop owns the vault. */
  | 'desktop'
  /** signal-cli through an external daemon (the browser build, or the desktop app pointed at one Snowdrop doesn't manage): Snowdrop owns none of that daemon's data. */
  | 'browser';

/** Decides the flow from what's actually running, not from an unapplied Settings → Connection edit. */
export function signOutFlowFor(
  app: Pick<AppServices, 'storageAdmin'> & { backend: Pick<AppServices['backend'], 'kind'> },
): SignOutFlow {
  if (app.backend.kind !== 'signal-cli') return 'demo';
  return app.storageAdmin ? 'desktop' : 'browser';
}

type ReloadApp = Pick<AppServices, 'stores' | 'admin'>;

type SignOutStores = Pick<AppServices['stores'], 'settings' | 'ui'>;

/**
 * Clears the saved backend choice (and, optionally, the account) and then
 * runs `step`, which must get that change to storage. The app root would swap
 * to the Welcome screen the moment the choice clears, taking the dialog that
 * reports progress and errors with it, so `ui.signingOut` holds it back for
 * the length of the flow. If `step` fails the choice is put back and
 * persisted again, so the user stays signed in (not on Welcome at the next
 * launch) and the caller can tell them what happened.
 */
async function withClearedConnection(
  app: { stores: SignOutStores; admin: Pick<AppAdmin, 'persist'> },
  cleared: { backend: null; account?: null },
  step: () => Promise<void>,
): Promise<void> {
  const { settings, ui } = app.stores;
  const { backend, account } = settings.getState().connection;
  ui.getState().setSigningOut(true);
  settings.getState().update('connection', cleared);
  try {
    await step();
  } catch (error) {
    settings.getState().update('connection', { backend, account });
    ui.getState().setSigningOut(false);
    try {
      await app.admin.persist();
    } catch (persistError) {
      // Storage may now hold the cleared choice while the account is intact.
      // Memory is back to normal, and persistence writes it again on the next
      // settings change or when the window closes, so this usually heals
      // itself; if not, the next launch shows Welcome and "Connect" picks the
      // same account up (nothing was removed).
      log.error(
        'restoring the connection after a failed sign-out did not reach storage',
        persistError,
      );
      throw new Error(
        `${describeFailure(error)}. Snowdrop also couldn’t save that you’re still signed in: if it shows the Welcome screen next time, choose Connect; your account is still on this computer.`,
        { cause: persistError },
      );
    }
    throw error;
  }
}

/**
 * "Leave demo" (no scary dialog, at most a light confirm): back to the
 * Welcome screen, settings kept. The demo's history is never persisted —
 * `backends.ts` registers it with `history: { kind: 'memory' }`, not an
 * IndexedDB name — so unlike signal-cli's it is never shared with a real
 * backend, and there is nothing to explicitly clear: the reload this
 * triggers already discards it along with the rest of the JS runtime.
 */
export async function leaveDemo(app: ReloadApp): Promise<void> {
  // Awaits the encrypted settings write before reloading (AppAdmin.reload).
  await withClearedConnection(app, { backend: null }, () => app.admin.reload());
}

/**
 * "Disconnect" from an external signal-cli daemon: back to the Welcome
 * screen, settings kept. Snowdrop never owned that daemon's data, so
 * nothing about it changes here — only the dialog's copy says so.
 */
export async function disconnectExternalDaemon(app: ReloadApp): Promise<void> {
  await withClearedConnection(app, { backend: null }, () => app.admin.reload());
}

/**
 * Thrown by `signOutDesktop` only when every step before restarting has
 * already succeeded — including `storageAdmin.signOut()` — but the restart
 * IPC itself rejected. There is nothing left to retry but the restart
 * itself: `SignOutDialog` catches this specifically to offer a "Restart
 * Snowdrop" fallback instead of re-enabling "Sign out" (docs/ENCRYPTION.md,
 * "Sign out").
 */
export class SignOutRestartFailed extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'SignOutRestartFailed';
  }
}

type DesktopSignOutApp = Pick<AppServices, 'storageAdmin'> & {
  stores: SignOutStores;
  admin: Pick<
    AppAdmin,
    'clearAccountData' | 'clearHistory' | 'disconnect' | 'persist' | 'setPendingHistoryClear'
  >;
};

/**
 * "Sign out" of signal-cli run by the desktop app itself (docs/ENCRYPTION.md,
 * "Sign out"). Order matters:
 *
 * 1. the backend/account choice is cleared first (Settings → Connection
 *    reads `connection.account` too, and must not show the old one), with
 *    `ui.signingOut` set so the app root keeps the dialog on screen;
 * 2. settings are flushed to encrypted storage and awaited — storage
 *    refuses writes once `storageAdmin.signOut()` has run;
 * 3. `storageAdmin.signOut()` removes this computer's signal-cli vault,
 *    keeping `keys.json` and the keyring entry so storage stays set up.
 *    If step 2 or 3 fails, the previous choice is restored and persisted
 *    and the error reaches the dialog: the user stays signed in;
 * 4. only now is the signed-out account's local data cleared (contact
 *    notes, pins, drafts, message-request decisions, peers list, cursors:
 *    `accountDataKeys`), and then the message cache — after the steps that can
 *    actually fail have succeeded, so a failure here never throws away data
 *    for nothing. If it fails anyway, a flag is persisted instead: the next
 *    boot unlocks with the same key, so the old cache would otherwise still
 *    be sitting there under whatever account signs in next;
 * 5. `storageAdmin.restart()` — the vault bridge and the single-instance
 *    lock are one-shot per process, so nothing it did takes effect for this
 *    process until a fresh one starts. Always runs, even if step 4 failed:
 *    the pending-clear flag means boot will finish the job.
 */
export async function signOutDesktop(app: DesktopSignOutApp): Promise<void> {
  const { storageAdmin } = app;
  if (!storageAdmin) throw new Error('signOutDesktop requires the desktop storage admin.');
  await withClearedConnection(app, { backend: null, account: null }, async () => {
    await app.admin.persist();
    await storageAdmin.signOut();
  });
  try {
    // Stop syncing first so nothing from the old account lands after the clear.
    await app.admin.disconnect();
    try {
      await app.admin.clearAccountData();
    } catch (error) {
      // Storage-only and not expected to fail; the message cache must go regardless.
      log.error('clearing the account\u2019s local data failed during sign-out', error);
    }
    await app.admin.clearHistory();
  } catch (error) {
    log.error('clearHistory failed during sign-out; the next boot will retry', error);
    try {
      await app.admin.setPendingHistoryClear(true);
    } catch (flagError) {
      // The vault is already gone, so this must not surface as a failed
      // sign-out: restart (or its fallback) is the only way forward.
      log.error('could not record the pending history clear', flagError);
    }
  }
  try {
    await storageAdmin.restart();
  } catch (error) {
    throw new SignOutRestartFailed(error);
  }
}
