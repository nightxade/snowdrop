/**
 * The close handshake (docs/ENCRYPTION.md, "signal-cli vault" — the last
 * write isn't lost): `lib.rs` intercepts the main window's close, emits
 * `snowdrop://flush-before-close`, and waits for the `app_close_ready`
 * command before actually exiting (with its own 3s fallback if nothing ever
 * answers). This is the webview half of that: run `handler` (bounded to its
 * own 2s cap, so a stuck flush can never block the close forever) and then
 * tell Rust it's safe to exit, regardless of how `handler` turned out.
 *
 * Not wired into the app UI here — that's a later task's job.
 */
import { appCloseReady } from './desktop';
import { tauriIpc, type TauriIpc } from './ipc';

/** Emitted by the Rust side (src-tauri/src/lib.rs) at `CloseRequested`. */
export const EVENT_FLUSH_BEFORE_CLOSE = 'snowdrop://flush-before-close';

const HANDLER_TIMEOUT_MS = 2_000;

/**
 * Runs `handler`, but never waits past `timeoutMs` for it to settle. A
 * handler that's still running when the timeout fires is left to finish (or
 * not) on its own; a handler that rejects before the timeout rejects this
 * too, so the caller can log it.
 */
async function withTimeout(handler: () => Promise<void>, timeoutMs: number): Promise<void> {
  const timer: { id?: ReturnType<typeof setTimeout> } = {};
  const timeout = new Promise<void>((resolve) => {
    timer.id = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([handler(), timeout]);
  } finally {
    clearTimeout(timer.id);
  }
}

/**
 * Registers `handler` to run once, right before the app closes, then tells
 * Rust it's safe to exit — whether `handler` finished, threw, or ran past
 * its own timeout. Returns the unlisten function, same as `TauriIpc.listen`.
 */
export async function onFlushBeforeClose(
  handler: () => Promise<void>,
  ipc: TauriIpc = tauriIpc,
): Promise<() => void> {
  return ipc.listen<unknown>(EVENT_FLUSH_BEFORE_CLOSE, () => {
    void withTimeout(handler, HANDLER_TIMEOUT_MS)
      .catch((error: unknown) => {
        console.warn('[snowdrop] flush before close failed', error);
      })
      .finally(() => {
        void appCloseReady(ipc);
      });
  });
}
