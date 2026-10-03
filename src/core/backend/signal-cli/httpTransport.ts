/**
 * signal-cli's HTTP daemon (`signal-cli daemon --http`): JSON-RPC 2.0 at
 * `POST /api/v1/rpc`, health at `GET /api/v1/check`, and incoming messages on
 * the SSE stream `GET /api/v1/events` (resumable with `Last-Event-ID`).
 * The browser reaches it through the same-origin dev proxy (`/signal-cli`).
 */
import type { Scheduler } from '@/core/lib';
import { SignalCliError } from './errors';
import { EventStream } from './sse';
import type {
  EventSubscription,
  EventSubscriptionOptions,
  FetchLike,
  RpcParams,
  RpcReply,
  SignalCliTransport,
  TransportCallOptions,
} from './transport';
import { isRecord } from './validate';

export type { FetchLike } from './transport';

export interface HttpTransportOptions {
  /** Daemon base URL, e.g. `/signal-cli` (dev proxy) or `http://127.0.0.1:8080`. */
  baseUrl: string;
  fetch?: FetchLike;
  scheduler?: Scheduler;
  random?: () => number;
  stream?: { initialDelayMs?: number; maxDelayMs?: number; idleTimeoutMs?: number };
}

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/u, '')}${path}`;
}

/** Bound `fetch` lazily so a test can stub the global after construction. */
const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export class HttpTransport implements SignalCliTransport {
  private nextId = 1;
  private readonly fetch: FetchLike;

  constructor(private readonly options: HttpTransportOptions) {
    this.fetch = options.fetch ?? globalFetch;
  }

  get resumeScope(): string {
    return 'http';
  }

  get description(): string {
    return `signal-cli at ${this.options.baseUrl}`;
  }

  async check(options: TransportCallOptions): Promise<void> {
    const response = await this.send(
      joinUrl(this.options.baseUrl, '/api/v1/check'),
      { method: 'GET' },
      options,
    );
    if (!response.ok) {
      throw new SignalCliError('http', `Daemon health check failed (HTTP ${response.status})`, {
        status: response.status,
      });
    }
  }

  async request(
    method: string,
    params: RpcParams | undefined,
    options: TransportCallOptions,
  ): Promise<RpcReply> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method,
      id: this.nextId++,
      ...(params && Object.keys(params).length > 0 ? { params } : {}),
    });
    const response = await this.send(
      joinUrl(this.options.baseUrl, '/api/v1/rpc'),
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
      options,
    );
    // Only for notifications; we always send an id, but be tolerant.
    if (response.status === 201) return { result: {} };
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
    return toReply(method, payload);
  }

  subscribe(options: EventSubscriptionOptions): EventSubscription {
    const query = options.account ? `?account=${encodeURIComponent(options.account)}` : '';
    return new EventStream({
      url: joinUrl(this.options.baseUrl, `/api/v1/events${query}`),
      fetch: this.fetch,
      ...(this.options.scheduler ? { scheduler: this.options.scheduler } : {}),
      ...(this.options.random ? { random: this.options.random } : {}),
      ...this.options.stream,
      lastEventId: options.resumeFrom,
      onEvent: (event) => {
        options.onEvent({
          type: event.type,
          data: event.data,
          cursor: event.lastEventId || undefined,
        });
      },
      onState: (state) => {
        options.onState(state);
      },
    });
  }

  private async send(
    url: string,
    init: RequestInit,
    options: TransportCallOptions,
  ): Promise<Response> {
    try {
      return await this.fetch(url, { ...init, signal: options.signal });
    } catch (cause) {
      // The client maps aborts (timeout or caller) itself.
      if (options.signal.aborted) throw cause;
      throw new SignalCliError('unreachable', `Cannot reach ${this.description}`, { cause });
    }
  }
}

/** Validates the shape of a JSON-RPC response object. */
export function toReply(method: string, payload: unknown): RpcReply {
  if (!isRecord(payload)) {
    throw new SignalCliError('invalid-response', `${method}: response is not an object`);
  }
  if (isRecord(payload.error)) {
    return {
      error: {
        code: typeof payload.error.code === 'number' ? payload.error.code : -32603,
        message:
          typeof payload.error.message === 'string' ? payload.error.message : 'Unknown error',
        data: payload.error.data ?? undefined,
      },
    };
  }
  return { result: payload.result };
}
