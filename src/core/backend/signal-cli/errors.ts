/**
 * Typed failures of the signal-cli transport, so callers (and the UI via
 * `error.kind`) can tell "daemon not running" from "rate limited" from
 * "that person isn't on Signal" without parsing strings.
 */
import type { RecipientFailure } from '../types';

export type SignalCliErrorKind =
  /** fetch failed: daemon not running, wrong URL, proxy down. */
  | 'unreachable'
  | 'timeout'
  /** Non-2xx HTTP status (421 = Host header rejected, 400 = unknown account on /events). */
  | 'http'
  /** No signal-cli program was found (desktop app; the message says how to install it). */
  | 'not-installed'
  /** A connection setting was rejected (desktop app: signal-cli path, account, daemon URL). */
  | 'config'
  /** The daemon answered with something that isn't the JSON we expect. */
  | 'invalid-response'
  /** The transport resolved something that isn't a valid JSON-RPC reply at all (not an object, or missing both `result` and `error`). */
  | 'protocol'
  /** The daemon has no registered/linked account (start the link flow). */
  | 'no-account'
  /**
   * A previously-linked account (`connection.account`) didn't come back from
   * `listAccounts` — signal-cli's own MultiAccountManager dropped it after a
   * transient failure checking it against the server on startup, and never
   * retries on its own. Distinct from `no-account`: never route this to the
   * (destructive) relink screen, only reconnect with backoff.
   */
  | 'account-unavailable'
  /**
   * Single-account daemon (`signal-cli -a +X daemon`): it can't tell us which
   * account it serves, so the user must enter it (settings `connection.account`).
   */
  | 'account-required'
  // JSON-RPC error codes (SignalJsonRpcCommandHandler):
  | 'user' // -1  bad input, group not found, …
  | 'unregistered' // -1 with "is not registered"
  | 'io' // -3
  | 'untrusted-identity' // -4
  | 'rate-limited' // -5
  | 'captcha-rejected' // -6
  | 'invalid-params' // -32602 / -32600
  | 'method-not-found' // -32601 (older daemon)
  | 'internal' // -32603
  /** A send reached nobody; see `recipientFailures`. */
  | 'send-failed'
  | 'aborted'
  /** The file is bigger than we'll pull through JSON; rejected locally, before any RPC call. */
  | 'too-large';

export interface SignalCliErrorInit {
  code?: number;
  status?: number;
  data?: unknown;
  recipientFailures?: RecipientFailure[];
  retryAfterSec?: number;
  cause?: unknown;
}

export class SignalCliError extends Error {
  override name = 'SignalCliError';
  readonly code: number | undefined;
  readonly status: number | undefined;
  readonly data: unknown;
  readonly recipientFailures: RecipientFailure[] | undefined;
  readonly retryAfterSec: number | undefined;

  constructor(
    readonly kind: SignalCliErrorKind,
    message: string,
    init: SignalCliErrorInit = {},
  ) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.status = init.status;
    this.data = init.data;
    this.recipientFailures = init.recipientFailures;
    this.retryAfterSec = init.retryAfterSec;
  }

  /** Worth retrying automatically (transient transport trouble). */
  get transient(): boolean {
    return (
      this.kind === 'unreachable' ||
      this.kind === 'timeout' ||
      this.kind === 'io' ||
      this.kind === 'account-unavailable' ||
      (this.kind === 'http' && (this.status ?? 0) >= 500)
    );
  }
}

export function isSignalCliError(error: unknown): error is SignalCliError {
  return error instanceof SignalCliError;
}

/**
 * A safe, content-free description of a thrown value for debug logs — its
 * class (and `SignalCliError.kind`), never its message, which can embed
 * identifiers or payload data pulled in by the code that threw.
 */
export function describeError(error: unknown): string {
  if (isSignalCliError(error)) return `SignalCliError(${error.kind})`;
  if (error instanceof Error) return error.constructor.name;
  return typeof error;
}

/** Maps a JSON-RPC error object to our error kind. */
export function kindForRpcCode(code: number, message: string): SignalCliErrorKind {
  switch (code) {
    case -1:
      return /not registered/iu.test(message) ? 'unregistered' : 'user';
    case -3:
      return 'io';
    case -4:
      return 'untrusted-identity';
    case -5:
      return 'rate-limited';
    case -6:
      return 'captcha-rejected';
    case -32600:
    case -32602:
      return 'invalid-params';
    case -32601:
      return 'method-not-found';
    default:
      return 'internal';
  }
}
