/**
 * How the signal-cli adapter reaches signal-cli. Everything above this
 * interface (JSON-RPC client, normaliser, backend) is transport-agnostic.
 *
 * - `HttpTransport` (this folder): the HTTP daemon (`daemon --http`), POST
 *   /api/v1/rpc and the SSE stream at /api/v1/events, through the dev proxy.
 * - The desktop app's transport (src/platform/tauri): the Rust side owns
 *   signal-cli (a child process speaking JSON-RPC on stdin/stdout, or a
 *   proxied external daemon) and the UI talks to it over Tauri IPC.
 *
 * Transports deliver raw JSON-RPC replies; the client turns error replies
 * into `SignalCliError`s and validates results.
 */
import type { SignalCliError } from './errors';

export type RpcParams = Record<string, unknown>;

/** The subset of `fetch` the HTTP transport uses; injected so tests can fake the daemon. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A JSON-RPC response, as received (id stripped). */
export type RpcReply =
  | { result: unknown; error?: undefined }
  | { error: { code: number; message: string; data?: unknown }; result?: undefined };

export interface TransportCallOptions {
  /** The transport should give up (and may cancel) once this fires. */
  signal: AbortSignal;
  timeoutMs: number;
}

/** One incoming event: a `receive` notification's payload (the envelope wrapper). */
export interface TransportEvent {
  /** "receive" for messages; other types are ignored by the adapter. */
  type: string;
  /** The payload: a JSON string (SSE) or already-parsed JSON (IPC). */
  data: unknown;
  /**
   * Opaque resume position *after* this event. Persisted (once the sync
   * engine has stored everything before it) and handed back as
   * `resumeFrom` on the next subscription.
   */
  cursor?: string | undefined;
}

export type EventStreamState =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'open' }
  | { kind: 'waiting'; attempt: number; delayMs: number; error: unknown }
  /** Gave up: a non-retryable failure (e.g. unknown account). */
  | { kind: 'failed'; error: SignalCliError }
  | { kind: 'closed' };

export interface EventSubscriptionOptions {
  /** Multi-account: the account to receive for. Null: a single-account signal-cli. */
  account: string | null;
  /** A cursor from an earlier session ('' = from now on). Unknown cursors are ignored. */
  resumeFrom: string;
  onEvent(event: TransportEvent): void;
  onState(state: EventStreamState): void;
}

export interface EventSubscription {
  start(): void;
  /** Stops and resolves once the subscription is torn down. */
  stop(): Promise<void>;
  /** Skips a pending reconnect wait (the user clicked Retry). */
  reconnectNow(): void;
}

export interface SignalCliTransport {
  /**
   * Scopes persisted resume cursors: cursors of one transport mean nothing
   * to another (an SSE event id vs a desktop session sequence number).
   */
  readonly resumeScope: string;
  /** Where signal-cli is, for error messages ("signal-cli at /signal-cli"). */
  readonly description: string;
  /** How long `check` may take (starting signal-cli takes longer than pinging a daemon). */
  readonly checkTimeoutMs?: number;
  /** Resolves when signal-cli is up (starting it first, if the transport owns it). */
  check(options: TransportCallOptions): Promise<void>;
  request(
    method: string,
    params: RpcParams | undefined,
    options: TransportCallOptions,
  ): Promise<RpcReply>;
  subscribe(options: EventSubscriptionOptions): EventSubscription;
  /**
   * Everything up to `cursor` is durably stored. The desktop transport holds
   * delivered events until then (see src-tauri/src/events.rs); HTTP needs nothing.
   */
  acknowledge?(cursor: string): void;
}
