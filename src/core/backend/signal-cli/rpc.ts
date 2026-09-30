/**
 * JSON-RPC 2.0 over signal-cli's HTTP endpoint (`POST /api/v1/rpc`).
 *
 * Every result is validated with a decoder before it leaves this module, and
 * every failure becomes a `SignalCliError` with a machine-readable kind.
 * In multi-account mode single-account methods need an `account` param; the
 * client injects the selected account unless a call opts out (`account: null`
 * for startLink/finishLink/listAccounts).
 */
import { kindForRpcCode, SignalCliError } from './errors';
import { decode, isRecord, type Decoder } from './validate';

/** The subset of `fetch` we use; injected so tests can fake the daemon. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface JsonRpcClientOptions {
  /** Daemon base URL, e.g. `/signal-cli` (dev proxy) or `http://127.0.0.1:8080`. */
  baseUrl: string;
  fetch?: FetchLike;
  /** Default per-call timeout. */
  timeoutMs?: number;
}

export interface CallOptions {
  /** Overrides the client's account; `null` sends no account param. */
  account?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type RpcParams = Record<string, unknown>;

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, '')}${path}`;
}

/** Bound `fetch` lazily so a test can stub the global after construction. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export class JsonRpcClient {
  /** Account injected into single-account calls (ACI or number). */
  account: string | undefined;
  private nextId = 1;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(private readonly options: JsonRpcClientOptions) {
    this.fetch = options.fetch ?? globalFetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  get baseUrl(): string {
    return this.options.baseUrl;
  }

  /** `GET /api/v1/check`: resolves when the daemon is up. */
  async check(options: Pick<CallOptions, 'timeoutMs' | 'signal'> = {}): Promise<void> {
    const response = await this.request(
      joinUrl(this.baseUrl, '/api/v1/check'),
      { method: 'GET' },
      options,
    );
    if (!response.ok) {
      throw new SignalCliError('http', `Daemon health check failed (HTTP ${response.status})`, {
        status: response.status,
      });
    }
  }

  async call<T>(
    method: string,
    params: RpcParams | undefined,
    decoder: Decoder<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const id = this.nextId++;
    const account = options.account === undefined ? this.account : options.account;
    const allParams: RpcParams = { ...params };
    if (account !== null && account !== undefined) allParams.account = account;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id,
      ...(Object.keys(allParams).length > 0 ? { params: allParams } : {}),
    });

    const response = await this.request(
      joinUrl(this.baseUrl, '/api/v1/rpc'),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      options,
    );
    if (response.status === 201) {
      // Only for notifications; we always send an id, but be tolerant.
      return this.decodeResult(method, {}, decoder);
    }
    if (!response.ok) {
      throw new SignalCliError(
        'http',
        response.status === 421
          ? 'Daemon rejected the Host header (use the dev proxy or a localhost URL)'
          : `HTTP ${response.status} from daemon`,
        { status: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new SignalCliError('invalid-response', `${method}: response is not JSON`, { cause });
    }
    if (!isRecord(payload)) {
      throw new SignalCliError('invalid-response', `${method}: response is not an object`);
    }
    if (isRecord(payload.error)) {
      const code = typeof payload.error.code === 'number' ? payload.error.code : -32603;
      const message =
        typeof payload.error.message === 'string' ? payload.error.message : 'Unknown error';
      throw new SignalCliError(kindForRpcCode(code, message), message, {
        code,
        data: payload.error.data ?? undefined,
      });
    }
    return this.decodeResult(method, payload.result, decoder);
  }

  private decodeResult<T>(method: string, value: unknown, decoder: Decoder<T>): T {
    const result = decode(decoder, value);
    if (!result.ok) {
      throw new SignalCliError('invalid-response', `${method}: ${result.error.message}`, {
        cause: result.error,
      });
    }
    return result.value;
  }

  private async request(
    url: string,
    init: RequestInit,
    options: Pick<CallOptions, 'timeoutMs' | 'signal'>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    // A holder object: TS can't see closure writes to a local `let`.
    const state = { timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, timeoutMs);
    const external = options.signal;
    const onAbort = (): void => {
      controller.abort();
    };
    if (external?.aborted) controller.abort();
    else external?.addEventListener('abort', onAbort, { once: true });
    try {
      return await this.fetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (state.timedOut) {
        throw new SignalCliError('timeout', `Daemon did not answer within ${timeoutMs} ms`, {
          cause,
        });
      }
      if (external?.aborted) throw new SignalCliError('aborted', 'Request aborted', { cause });
      throw new SignalCliError('unreachable', `Cannot reach signal-cli at ${this.baseUrl}`, {
        cause,
      });
    } finally {
      clearTimeout(timer);
      external?.removeEventListener('abort', onAbort);
    }
  }
}
