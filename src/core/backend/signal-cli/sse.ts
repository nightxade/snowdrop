/**
 * Server-Sent Events over `fetch`, for signal-cli's `GET /api/v1/events`.
 *
 * Why not `EventSource`: it can't set `Last-Event-ID` on the *first*
 * connection (so resuming after a page reload is impossible), gives no access
 * to HTTP status codes, and its built-in reconnect has no backoff. We parse
 * the stream ourselves (WHATWG "event stream interpretation"), reconnect with
 * exponential backoff + jitter, resume with `Last-Event-ID`, and treat a
 * silent connection (no keep-alive comment for `idleTimeoutMs`) as dead.
 */
import { systemScheduler, type Cancel, type Scheduler } from '@/core/lib';
import { SignalCliError } from './errors';
import type { FetchLike } from './rpc';

export interface SseEvent {
  /** `event:` field; "message" when absent. signal-cli uses "receive". */
  type: string;
  data: string;
  /** The last event id *after* this event (spec: carried over when unset). */
  lastEventId: string;
}

export interface SseParserHandlers {
  onEvent(event: SseEvent): void;
  /** `retry:` field (reconnection time in ms). */
  onRetry?(ms: number): void;
  /** Comment lines (`:` prefix) — signal-cli's keep-alives. */
  onComment?(text: string): void;
}

/**
 * Incremental SSE parser. Feed it decoded text in arbitrary chunks; chunk
 * boundaries may fall anywhere, including between `\r` and `\n`.
 */
export class SseParser {
  private buffer = '';
  private data = '';
  private hasData = false;
  private eventType = '';
  private lastEventId: string;
  /** A chunk ended in `\r`: a leading `\n` in the next chunk belongs to it. */
  private skipLeadingLf = false;
  private firstChunk = true;

  constructor(
    private readonly handlers: SseParserHandlers,
    initialLastEventId = '',
  ) {
    this.lastEventId = initialLastEventId;
  }

  get currentLastEventId(): string {
    return this.lastEventId;
  }

  feed(chunk: string): void {
    let text = chunk;
    if (this.firstChunk && text.length > 0) {
      this.firstChunk = false;
      if (text.startsWith('﻿')) text = text.slice(1);
    }
    if (this.skipLeadingLf && text.startsWith('\n')) text = text.slice(1);
    this.skipLeadingLf = false;
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      this.processLine(this.buffer.slice(start, i));
      if (ch === '\r') {
        if (i + 1 < this.buffer.length) {
          if (this.buffer[i + 1] === '\n') i++;
        } else {
          this.skipLeadingLf = true;
        }
      }
      start = i + 1;
    }
    this.buffer = this.buffer.slice(start);
  }

  /** Discards a partial event (the connection dropped mid-event). */
  reset(): void {
    this.buffer = '';
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    this.skipLeadingLf = false;
    this.firstChunk = true;
  }

  private processLine(line: string): void {
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) {
      this.handlers.onComment?.(line.slice(1));
      return;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.eventType = value;
        break;
      case 'data':
        this.data += `${value}\n`;
        this.hasData = true;
        break;
      case 'id':
        if (!value.includes('\0')) this.lastEventId = value;
        break;
      case 'retry':
        if (/^\d+$/u.test(value)) this.handlers.onRetry?.(Number(value));
        break;
      default:
        // Unknown fields are ignored per spec.
        break;
    }
  }

  private dispatch(): void {
    const hasData = this.hasData;
    const data = this.data.endsWith('\n') ? this.data.slice(0, -1) : this.data;
    const type = this.eventType || 'message';
    this.data = '';
    this.hasData = false;
    this.eventType = '';
    if (!hasData) return;
    this.handlers.onEvent({ type, data, lastEventId: this.lastEventId });
  }
}

// ─── Reconnecting stream ─────────────────────────────────────────────────

export type EventStreamState =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'open' }
  | { kind: 'waiting'; attempt: number; delayMs: number; error: unknown }
  /** Gave up: a non-retryable response (e.g. 400 unknown account). */
  | { kind: 'failed'; error: SignalCliError }
  | { kind: 'closed' };

export interface EventStreamOptions {
  url: string;
  fetch?: FetchLike;
  scheduler?: Scheduler;
  /** [0, 1) — injected for deterministic jitter in tests. */
  random?: () => number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  /** No bytes (not even a keep-alive) for this long ⇒ reconnect. signal-cli pings every 15 s. */
  idleTimeoutMs?: number;
  lastEventId?: string;
  onEvent(event: SseEvent): void;
  onState?(state: EventStreamState): void;
}

/**
 * Backoff with "equal jitter": half the exponential delay is fixed, half is
 * random, so a daemon restart doesn't get every tab reconnecting in lockstep
 * but a single client still backs off predictably.
 */
export function backoffDelay(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number,
): number {
  const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exp / 2 + random() * (exp / 2));
}

/** HTTP statuses that retrying can't fix. */
const FATAL_STATUSES = new Set([400, 401, 403, 404, 405, 421]);

const globalFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export class EventStream {
  private readonly fetch: FetchLike;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly maxDelayMs: number;
  private readonly idleTimeoutMs: number;
  private baseDelayMs: number;
  private lastId: string;
  private running = false;
  private controller: AbortController | null = null;
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(private readonly options: EventStreamOptions) {
    this.fetch = options.fetch ?? globalFetch;
    this.scheduler = options.scheduler ?? systemScheduler;
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.initialDelayMs ?? 1_000;
    this.maxDelayMs = options.maxDelayMs ?? 30_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 45_000;
    this.lastId = options.lastEventId ?? '';
  }

  /** Id of the last event received; persist it to resume after a reload. */
  get lastEventId(): string {
    return this.lastId;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops and resolves once the connection is torn down. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.controller?.abort();
    this.wake?.();
    await this.loop;
    this.loop = null;
  }

  /** Skips the current backoff wait (e.g. the user clicked "Retry" or the browser came online). */
  reconnectNow(): void {
    this.wake?.();
  }

  /** Read through a method so TS doesn't narrow away changes made by stop(). */
  private isRunning(): boolean {
    return this.running;
  }

  private emitState(state: EventStreamState): void {
    try {
      this.options.onState?.(state);
    } catch (error) {
      console.error('[snowdrop] signal-cli stream state listener failed', error);
    }
  }

  private async run(): Promise<void> {
    let attempt = 0;
    while (this.running) {
      this.emitState({ kind: 'connecting', attempt });
      let error: unknown;
      try {
        await this.connectOnce(() => {
          attempt = 0;
        });
        error = new SignalCliError('unreachable', 'Event stream ended');
      } catch (e) {
        error = e;
        if (e instanceof SignalCliError && e.kind === 'http' && FATAL_STATUSES.has(e.status ?? 0)) {
          this.running = false;
          this.emitState({ kind: 'failed', error: e });
          return;
        }
      }
      // stop() may have run while we were connected.
      if (!this.isRunning()) break;
      const delayMs = backoffDelay(attempt, this.baseDelayMs, this.maxDelayMs, this.random);
      this.emitState({ kind: 'waiting', attempt, delayMs, error });
      attempt++;
      await this.sleep(delayMs);
    }
    this.emitState({ kind: 'closed' });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let cancel: Cancel | null = null;
      const done = (): void => {
        cancel?.();
        this.wake = null;
        resolve();
      };
      this.wake = done;
      cancel = this.scheduler.setTimeout(done, ms);
    });
  }

  private async connectOnce(onOpen: () => void): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    // A holder object: TS can't see closure writes to a local `let`.
    const idle: { cancel: Cancel | null } = { cancel: null };
    const armIdle = (): void => {
      idle.cancel?.();
      idle.cancel = this.scheduler.setTimeout(() => {
        controller.abort();
      }, this.idleTimeoutMs);
    };

    const headers: Record<string, string> = { Accept: 'text/event-stream' };
    if (this.lastId) headers['Last-Event-ID'] = this.lastId;
    const parser = new SseParser(
      {
        onEvent: (event) => {
          this.lastId = event.lastEventId;
          this.options.onEvent(event);
        },
        onRetry: (ms) => {
          this.baseDelayMs = ms;
        },
      },
      this.lastId,
    );

    try {
      armIdle();
      let response: Response;
      try {
        response = await this.fetch(this.options.url, {
          method: 'GET',
          headers,
          cache: 'no-store',
          signal: controller.signal,
        });
      } catch (cause) {
        throw new SignalCliError('unreachable', 'Cannot open the signal-cli event stream', {
          cause,
        });
      }
      if (!response.ok || !response.body) {
        throw new SignalCliError('http', `Event stream HTTP ${response.status}`, {
          status: response.status,
        });
      }
      this.emitState({ kind: 'open' });
      onOpen();
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          armIdle();
          parser.feed(decoder.decode(value, { stream: true }));
        }
      } finally {
        reader.releaseLock();
      }
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof SignalCliError)) {
        throw new SignalCliError(this.running ? 'timeout' : 'aborted', 'Event stream closed', {
          cause: error,
        });
      }
      throw error;
    } finally {
      idle.cancel?.();
      if (this.controller === controller) this.controller = null;
    }
  }
}
