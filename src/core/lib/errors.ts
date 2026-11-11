/**
 * One error contract for the whole app. Every layer used to invent its own
 * "what went wrong / may it be retried / may it have happened anyway"; this is
 * the shared shape. The transport families (`SignalCliError`, the desktop
 * command errors, `MockBackendError`) extend {@link AppError}, and
 * {@link toAppError} converts anything else thrown, at the boundary where a
 * failure is first caught, so nothing downstream has to duck-type a `kind`.
 *
 * PRIVACY: `message` is a technical detail that can embed identifiers or
 * payload data. It is for the debug disclosure, never for logs at info and
 * above and never shown as-is; the UI maps `kind` to copy
 * (src/ui/lib/connectionErrors.ts). Logs name an error by {@link describeError}.
 */
import { createLogger } from './log';

/** Every machine-readable reason a failure can carry, from any family. */
export type ErrorKind =
  // transport and setup
  | 'unreachable'
  | 'timeout'
  | 'http'
  | 'not-installed'
  | 'config'
  | 'invalid-response'
  | 'protocol'
  | 'no-account'
  | 'account-unavailable'
  | 'account-required'
  | 'aborted'
  | 'cancelled'
  | 'too-large'
  // JSON-RPC error codes
  | 'user'
  | 'unregistered'
  | 'io'
  | 'untrusted-identity'
  | 'rate-limited'
  | 'captcha-rejected'
  | 'invalid-params'
  | 'method-not-found'
  | 'internal'
  | 'send-failed'
  // local storage and keyring (desktop)
  | 'keyring-unavailable'
  | 'keyring-locked'
  | 'keyring-corrupt'
  | 'keyring-secret-missing'
  | 'auth-failed'
  | 'slot-missing'
  | 'last-unlock-method'
  | 'keys-file-corrupt'
  | 'recovery-code-typo'
  | 'vault-corrupt'
  | 'vault-blob-corrupt'
  | 'no-ram-dir'
  | 'already-running'
  | 'storage-locked'
  /** Anything that arrived without a kind of its own. */
  | 'unknown';

/**
 * Whether what the failed call asked for may have happened anyway:
 * `not-sent` it certainly did not; `maybe-sent` the request left and the
 * answer was lost or late (a send may still be delivered); `unknown` the
 * failure can't say.
 */
export type ErrorOutcome = 'not-sent' | 'maybe-sent' | 'unknown';

export interface AppErrorInit {
  /** Worth retrying automatically (transient trouble). Default false. */
  transient?: boolean;
  /** Default `maybe-sent` for a timeout (the request may have landed), else `unknown`. */
  outcome?: ErrorOutcome;
  /**
   * Where the failure came from, when the copy for its kind depends on it
   * ("signal-cli" wording only makes sense for errors from signal-cli).
   */
  source?: ErrorSource;
  cause?: unknown;
}

export type ErrorSource = 'signal-cli';

export class AppError extends Error {
  override name = 'AppError';
  /** Worth retrying automatically. */
  readonly transient: boolean;
  readonly outcome: ErrorOutcome;
  readonly source: ErrorSource | undefined;

  constructor(
    readonly kind: ErrorKind,
    message: string,
    init: AppErrorInit = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.transient = init.transient ?? false;
    this.outcome = init.outcome ?? (kind === 'timeout' ? 'maybe-sent' : 'unknown');
    this.source = init.source;
  }
}

/** The `kind` of a failure in an object shape: a non-empty string, else null. */
function kindOf(value: object): string | null {
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === 'string' && kind !== '' ? kind : null;
}

/**
 * Converts anything thrown into an {@link AppError}. An `AppError` is returned
 * as is. An object with a string `kind` (a wire error from the desktop shell,
 * or any adapter's typed error) keeps that kind, its `message`, and the
 * `transient` / `requestSent` hints it carries. Everything else becomes
 * `unknown`, keeping the original as `cause`.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (typeof error === 'object' && error !== null) {
    const hints = error as { message?: unknown; transient?: unknown; requestSent?: unknown };
    const kind = kindOf(error) ?? 'unknown';
    const message = typeof hints.message === 'string' ? hints.message : '';
    const sent = hints.requestSent === true || kind === 'timeout';
    if (kind !== 'unknown' || sent || error instanceof Error) {
      return new AppError(kind as ErrorKind, message, {
        transient: hints.transient === true,
        outcome: sent ? 'maybe-sent' : 'unknown',
        cause: error,
      });
    }
  }
  return new AppError('unknown', String(error), { cause: error });
}

/**
 * A safe, content-free description of a thrown value for logs: its class (and
 * `kind`), never its message, which can embed identifiers or payload data.
 */
export function describeError(error: unknown): string {
  if (error instanceof AppError) return `${error.name}(${error.kind})`;
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}

const log = createLogger('app');

/**
 * Says out loud that a failure is deliberately dropped, and why. Logs at
 * debug with the reason and the failure's class only (no message, no data).
 * Use it instead of an empty catch.
 */
export function ignore(error: unknown, reason: string): void {
  log.debug(`ignored: ${reason}`, describeError(error));
}

/** `.catch(ignored('why'))`: {@link ignore} as a promise rejection handler. */
export function ignored(reason: string): (error: unknown) => void {
  return (error) => {
    ignore(error, reason);
  };
}
