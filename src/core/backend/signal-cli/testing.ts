/**
 * Test doubles for the daemon's HTTP surface: a scriptable `fetch` that
 * answers JSON-RPC calls and serves controllable SSE streams.
 * Test-only; nothing in the app imports this.
 */
import type { FetchLike } from './rpc';

export interface RpcCall {
  method: string;
  params: Record<string, unknown>;
}

export type RpcHandler = (
  params: Record<string, unknown>,
) => { result: unknown } | { error: { code: number; message: string; data?: unknown } };

/** An SSE response body the test pushes text into. */
export class FakeEventStream {
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  private readonly encoder = new TextEncoder();
  closed = false;
  readonly body: ReadableStream<Uint8Array>;

  constructor(
    readonly headers: Headers,
    signal: AbortSignal | undefined,
  ) {
    this.body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    signal?.addEventListener('abort', () => {
      this.fail(new DOMException('aborted', 'AbortError'));
    });
  }

  push(text: string): void {
    if (!this.closed) this.controller?.enqueue(this.encoder.encode(text));
  }

  /** Server closes the stream cleanly. */
  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }

  fail(error: unknown): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.error(error);
  }
}

export class FakeDaemon {
  readonly calls: RpcCall[] = [];
  readonly streams: FakeEventStream[] = [];
  readonly streamUrls: string[] = [];
  private readonly handlers = new Map<string, RpcHandler>();
  /** Status for the next /events requests (e.g. 400, 500); shifted per request. */
  eventStatuses: number[] = [];
  up = true;

  /** Answers `method` through a handler (can inspect params, return errors). */
  handle(method: string, handler: RpcHandler): this {
    this.handlers.set(method, handler);
    return this;
  }

  /** Always answers `method` with the same result. */
  reply(method: string, result: unknown): this {
    return this.handle(method, () => ({ result }));
  }

  callsTo(method: string): Record<string, unknown>[] {
    return this.calls.filter((c) => c.method === method).map((c) => c.params);
  }

  get lastStream(): FakeEventStream | undefined {
    return this.streams.at(-1);
  }

  readonly fetch: FetchLike = (input, init) => {
    if (!this.up) return Promise.reject(new TypeError('Failed to fetch'));
    const url = new URL(input, 'http://daemon.test');
    if (url.pathname.endsWith('/api/v1/check')) {
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    if (url.pathname.endsWith('/api/v1/events')) {
      this.streamUrls.push(input);
      const status = this.eventStatuses.shift() ?? 200;
      if (status !== 200) return Promise.resolve(new Response(null, { status }));
      const stream = new FakeEventStream(new Headers(init?.headers), init?.signal ?? undefined);
      this.streams.push(stream);
      return Promise.resolve(
        new Response(stream.body, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      );
    }
    if (url.pathname.endsWith('/api/v1/rpc')) {
      const request = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
      };
      const params = request.params ?? {};
      this.calls.push({ method: request.method, params });
      const handler = this.handlers.get(request.method);
      const reply = handler
        ? handler(params)
        : { error: { code: -32601, message: 'Method not implemented' } };
      return Promise.resolve(
        new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...reply }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
}

/** Lets pending promise chains (fetch → reader → parser) run. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setTimeout(r, 0));
}
