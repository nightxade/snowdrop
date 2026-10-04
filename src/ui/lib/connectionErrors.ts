/**
 * Plain, specific copy for the ways a signal-cli connection (or its
 * download) can fail — the single place that maps an error kind to what the
 * UI shows, reused by the chat connection banner, onboarding, Settings →
 * Connection and the first-run download screen, so the same failure reads
 * the same way everywhere and never as a raw exception string.
 *
 * Keyed by `SignalCliErrorKind`, `DesktopErrorKind`, and `probeDaemon`'s
 * `'unknown'` — all plain strings, so this takes `string | null | undefined`
 * rather than importing those types (and dragging a dependency on the
 * signal-cli adapter or the desktop platform layer into shared UI code).
 *
 * Most kinds hide the engine's own message entirely: `-32603 (boom
 * (NullPointerException))` is not something to show anyone. A few kinds —
 * `not-installed`, `account-required`, `config` — already carry a message
 * the adapter wrote *for* display (see src/core/backend/signal-cli/errors.ts
 * and src-tauri/src/config.rs), so those pass it through, with one or two
 * keyword-based rewrites for the phrasing we can make clearer.
 */

type DetailMessage = (detail: string) => string;

const PASS_THROUGH_FALLBACKS: Record<string, string> = {
  'no-account': 'No Signal account is linked yet.',
  'account-required': 'This signal-cli needs an account number to use.',
  'not-installed': "Snowdrop couldn't find signal-cli.",
  config: "That connection setting isn't valid.",
  aborted: 'Cancelled.',
  cancelled: 'Download cancelled.',
};

const GENERIC_MESSAGES: Record<string, DetailMessage> = {
  unreachable: () =>
    "Couldn't connect. Check your network, and that the other side is running, then try again.",
  timeout: () => "That didn't answer in time. Try again.",
  http: (detail) =>
    /host header/iu.test(detail)
      ? 'The connection was rejected (a proxy or Host header problem). Use the dev proxy or a localhost address.'
      : 'The connection was refused.',
  'invalid-response': () => "Something answered, but it wasn't signal-cli.",
  protocol: () => "signal-cli sent something Snowdrop couldn't understand.",
  user: () => 'signal-cli rejected that request.',
  unregistered: () => "That person isn't on Signal.",
  io: () => 'signal-cli had a problem reading or writing data.',
  'untrusted-identity': () =>
    "The recipient's safety number changed. Verify it before sending again.",
  'rate-limited': () => 'Signal is rate-limiting this account. Try again shortly.',
  'captcha-rejected': () => 'That captcha was rejected.',
  'invalid-params': () => 'signal-cli rejected that request.',
  'method-not-found': () => 'This signal-cli is too old for that.',
  'keyring-unavailable': () => 'No keyring service is available on this system.',
  'keyring-locked': () => 'The keyring is locked. Unlock it and try again.',
  'keyring-corrupt': () => "The keyring entry Snowdrop stored isn't valid.",
  'keyring-secret-missing': () =>
    "The keyring doesn't have Snowdrop's key. This happens after switching keyrings.",
  'storage-locked': () => 'Local storage is locked. Unlock it to connect.',
  'auth-failed': () => "That didn't match.",
  'slot-missing': () => "That unlock method isn't set up.",
  'last-unlock-method': () =>
    "That's the only way left to unlock Snowdrop. Set up another method first.",
  'keys-file-corrupt': () => "Snowdrop's key file isn't valid.",
  'recovery-code-typo': () => "That recovery key has a typo — check it against what you saved.",
  'vault-corrupt': () => "Snowdrop's local data is unreadable.",
  'vault-blob-corrupt': () => 'A piece of local data is unreadable.',
  'no-ram-dir': () => 'No RAM-backed storage is available on this computer.',
  'already-running': () => 'Snowdrop is already open.',
  internal: (detail) =>
    /no space/iu.test(detail)
      ? "Couldn't save signal-cli: the disk may be full."
      : 'signal-cli ran into an internal problem.',
  'send-failed': () => "That message didn't reach everyone.",
};

const FALLBACK = "Snowdrop couldn't complete that.";

/**
 * A plain, specific sentence for `kind`, safe to show directly in the UI.
 * `detail` — the raw technical message, from `error.message` — is used only
 * to choose between two phrasings for the same kind (a checksum mismatch, a
 * full disk, a rejected Host header); it is never interpolated into what's
 * returned. Keep the raw `detail` itself behind a "Details" disclosure, or
 * send it to the console — never show it next to this.
 */
export function friendlyErrorMessage(
  kind: string | null | undefined,
  detail: string | null | undefined = '',
): string {
  const safeDetail = detail ?? '';
  if (!kind) return FALLBACK;
  if (kind === 'config' && /checksum/iu.test(safeDetail)) {
    return "The download didn't match what Snowdrop expected (a checksum mismatch). Try again — if it keeps happening, your network may be altering the download.";
  }
  const passThroughFallback = PASS_THROUGH_FALLBACKS[kind];
  if (passThroughFallback !== undefined) return safeDetail || passThroughFallback;
  const generic = GENERIC_MESSAGES[kind];
  return generic ? generic(safeDetail) : FALLBACK;
}
