// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { backoffDelay, EventStream, SseParser, type EventStreamState, type SseEvent } from './sse';
import { FakeDaemon, flush } from './testing';

function parse(chunks: string[], lastEventId = '') {
  const events: SseEvent[] = [];
  const retries: number[] = [];
  const comments: string[] = [];
  const parser = new SseParser(
    {
      onEvent: (e) => events.push(e),
      onRetry: (ms) => retries.push(ms),
      onComment: (c) => comments.push(c),
    },
    lastEventId,
  );
  for (const c of chunks) parser.feed(c);
  return { events, retries, comments };
}

const SAMPLE =
  ':\n' +
  'id:1790000000000-1\nevent:receive\ndata:{"a":1}\n\n' +
  ': keep-alive\n' +
  'id: 1790000000000-2\nevent: receive\ndata: line one\ndata: line two\n\n' +
  'retry: 2500\n' +
  'data\n\n';

describe('SseParser', () => {
  it('parses signal-cli framing: ids, event types, multi-line data, comments, retry', () => {
    const { events, retries, comments } = parse([SAMPLE]);
    expect(events).toEqual([
      { type: 'receive', data: '{"a":1}', lastEventId: '1790000000000-1' },
      { type: 'receive', data: 'line one\nline two', lastEventId: '1790000000000-2' },
      // `data` with no colon = empty data line; the id carries over.
      { type: 'message', data: '', lastEventId: '1790000000000-2' },
    ]);
    expect(retries).toEqual([2500]);
    expect(comments).toEqual(['', ' keep-alive']);
  });

  it('is independent of chunk boundaries', () => {
    const whole = parse([SAMPLE]).events;
    expect(parse(SAMPLE.split('')).events).toEqual(whole);
    for (let cut = 1; cut < SAMPLE.length; cut += 7) {
      expect(parse([SAMPLE.slice(0, cut), SAMPLE.slice(cut)]).events).toEqual(whole);
    }
  });

  it('handles CRLF and CR line endings, including CRLF split across chunks', () => {
    const crlf = SAMPLE.replaceAll('\n', '\r\n');
    expect(parse(crlf.split('')).events).toEqual(parse([SAMPLE]).events);
    expect(parse(['data: x\r', '\ndata: y\r', '\r']).events).toEqual([
      { type: 'message', data: 'x\ny', lastEventId: '' },
    ]);
  });

  it('does not dispatch an event without data, but keeps its id', () => {
    const { events } = parse(['id: 7\n\n', 'data: after\n\n']);
    expect(events).toEqual([{ type: 'message', data: 'after', lastEventId: '7' }]);
  });

  it('ignores ids containing NUL, unknown fields, a leading BOM, and bad retry values', () => {
    const { events, retries } = parse(['﻿id: a\0b\nfoo: bar\nretry: 1s\ndata: z\n\n'], 'x');
    expect(events).toEqual([{ type: 'message', data: 'z', lastEventId: 'x' }]);
    expect(retries).toEqual([]);
  });

  it('does not dispatch a trailing partial event', () => {
    expect(parse(['data: partial']).events).toEqual([]);
  });
});

describe('backoffDelay', () => {
  it('grows exponentially with equal jitter and caps', () => {
    expect(backoffDelay(0, 1000, 30_000, () => 0)).toBe(500);
    expect(backoffDelay(0, 1000, 30_000, () => 0.999_999)).toBe(1000);
    expect(backoffDelay(3, 1000, 30_000, () => 0.5)).toBe(6000);
    expect(backoffDelay(20, 1000, 30_000, () => 0)).toBe(15_000);
  });
});

function setupStream(daemon: FakeDaemon, lastEventId = '') {
  const scheduler = new ManualScheduler(0);
  const events: SseEvent[] = [];
  const states: EventStreamState[] = [];
  const stream = new EventStream({
    url: 'http://daemon.test/api/v1/events?account=%2B1555',
    fetch: daemon.fetch,
    scheduler,
    random: () => 0,
    initialDelayMs: 1000,
    maxDelayMs: 8000,
    idleTimeoutMs: 45_000,
    lastEventId,
    onEvent: (e) => events.push(e),
    onState: (s) => states.push(s),
  });
  return { scheduler, stream, events, states };
}

describe('EventStream', () => {
  it('streams events and resumes with Last-Event-ID after the server drops', async () => {
    const daemon = new FakeDaemon();
    const { scheduler, stream, events, states } = setupStream(daemon);
    stream.start();
    await flush();
    const first = daemon.lastStream!;
    expect(first.headers.get('Accept')).toBe('text/event-stream');
    expect(first.headers.get('Last-Event-ID')).toBeNull();
    expect(states.at(-1)).toEqual({ kind: 'open' });

    first.push('id:run-1\nevent:receive\ndata:{"n":1}\n\n');
    await flush();
    expect(events.map((e) => e.data)).toEqual(['{"n":1}']);
    expect(stream.lastEventId).toBe('run-1');

    first.end();
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'waiting', attempt: 0, delayMs: 500 });
    expect(daemon.streams).toHaveLength(1);
    scheduler.advance(500);
    await flush();
    expect(daemon.streams).toHaveLength(2);
    expect(daemon.lastStream!.headers.get('Last-Event-ID')).toBe('run-1');
    await stream.stop();
    expect(states.at(-1)).toEqual({ kind: 'closed' });
  });

  it('sends a persisted Last-Event-ID on the very first connection', async () => {
    const daemon = new FakeDaemon();
    const { stream } = setupStream(daemon, 'run-41');
    stream.start();
    await flush();
    expect(daemon.lastStream!.headers.get('Last-Event-ID')).toBe('run-41');
    await stream.stop();
  });

  it('backs off exponentially while the daemon is down, then recovers', async () => {
    const daemon = new FakeDaemon();
    daemon.up = false;
    const { scheduler, stream, states } = setupStream(daemon);
    stream.start();
    const delays: number[] = [];
    for (let i = 0; i < 5; i++) {
      await flush();
      const s = states.at(-1);
      if (s?.kind !== 'waiting') throw new Error(`expected waiting, got ${s?.kind}`);
      delays.push(s.delayMs);
      scheduler.advance(s.delayMs);
    }
    expect(delays).toEqual([500, 1000, 2000, 4000, 4000]);
    daemon.up = true;
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'open' });
    // A successful open resets the backoff.
    daemon.lastStream!.end();
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'waiting', delayMs: 500 });
    await stream.stop();
  });

  it('honours the server retry field as the base delay', async () => {
    const daemon = new FakeDaemon();
    const { stream, states } = setupStream(daemon);
    stream.start();
    await flush();
    daemon.lastStream!.push('retry: 4000\n\n');
    daemon.lastStream!.end();
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'waiting', delayMs: 2000 });
    await stream.stop();
  });

  it('gives up on non-retryable statuses (unknown account)', async () => {
    const daemon = new FakeDaemon();
    daemon.eventStatuses = [400];
    const { stream, states } = setupStream(daemon);
    stream.start();
    await flush();
    const last = states.at(-1);
    expect(last?.kind).toBe('failed');
    if (last?.kind === 'failed') expect(last.error.status).toBe(400);
    await stream.stop();
  });

  it('retries server errors', async () => {
    const daemon = new FakeDaemon();
    daemon.eventStatuses = [503];
    const { scheduler, stream, states } = setupStream(daemon);
    stream.start();
    await flush();
    expect(states.at(-1)).toMatchObject({ kind: 'waiting' });
    scheduler.advance(500);
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'open' });
    await stream.stop();
  });

  it('treats a silent connection as dead; keep-alives keep it open', async () => {
    const daemon = new FakeDaemon();
    const { scheduler, stream, states } = setupStream(daemon);
    stream.start();
    await flush();
    scheduler.advance(30_000);
    daemon.lastStream!.push(':\n');
    await flush();
    scheduler.advance(30_000);
    await flush();
    expect(states.at(-1)).toEqual({ kind: 'open' });
    scheduler.advance(20_000);
    await flush();
    expect(daemon.streams[0]!.closed).toBe(true);
    expect(states.at(-1)).toMatchObject({ kind: 'waiting' });
    await stream.stop();
  });

  it('stop() aborts an open connection and a pending backoff', async () => {
    const daemon = new FakeDaemon();
    const { stream, states } = setupStream(daemon);
    stream.start();
    await flush();
    await stream.stop();
    expect(daemon.lastStream!.closed).toBe(true);
    expect(states.at(-1)).toEqual({ kind: 'closed' });

    daemon.up = false;
    const second = setupStream(daemon);
    second.stream.start();
    await flush();
    expect(second.states.at(-1)?.kind).toBe('waiting');
    await second.stream.stop();
    expect(second.states.at(-1)).toEqual({ kind: 'closed' });
  });
});
