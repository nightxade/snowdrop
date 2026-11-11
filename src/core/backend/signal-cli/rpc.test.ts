// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { SignalCliError } from './errors';
import { enrichSendError } from './params';
import { JsonRpcClient, type FetchLike } from './rpc';
import { FakeDaemon } from './testing';
import type { SignalCliTransport } from './transport';
import { unknownValue } from './validate';
import { wireSendResult } from './wire';

function client(daemon: FakeDaemon, fetch: FetchLike = daemon.fetch) {
  return new JsonRpcClient({ baseUrl: '/signal-cli/', fetch, timeoutMs: 50 });
}

/** A transport whose `request` resolves whatever raw (possibly malformed) value is given. */
function rawTransport(reply: unknown): SignalCliTransport {
  return {
    resumeScope: 'test',
    description: 'test transport',
    check: () => Promise.resolve(),
    request: () => Promise.resolve(reply as never),
    subscribe: () => {
      throw new Error('not used in these tests');
    },
  };
}

async function failure(promise: Promise<unknown>): Promise<SignalCliError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SignalCliError) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

describe('JsonRpcClient', () => {
  it('posts JSON-RPC 2.0 with the account param and validates the result', async () => {
    const daemon = new FakeDaemon().reply('send', { timestamp: 42, results: [] });
    const rpc = client(daemon);
    rpc.account = '+15550000000';
    const result = await rpc.call('send', { recipient: ['+1555'] }, wireSendResult);
    expect(result).toEqual({ timestamp: 42, results: [] });
    expect(daemon.calls).toEqual([
      { method: 'send', params: { recipient: ['+1555'], account: '+15550000000' } },
    ]);
  });

  it('omits the account for multi-account methods', async () => {
    const daemon = new FakeDaemon().reply('listAccounts', []);
    const rpc = client(daemon);
    rpc.account = 'x';
    await rpc.call('listAccounts', undefined, unknownValue, { account: null });
    expect(daemon.calls[0]!.params).toEqual({});
  });

  it.each([
    [-1, 'Invalid group id', 'user'],
    [-1, 'The user +1555 is not registered.', 'unregistered'],
    [-3, 'IO error', 'io'],
    [-4, 'Failed to send message due to untrusted identities', 'untrusted-identity'],
    [-5, 'Rate limit exceeded', 'rate-limited'],
    [-6, 'Captcha rejected', 'captcha-rejected'],
    [-32602, 'Method requires valid account parameter', 'invalid-params'],
    [-32601, 'Method not implemented', 'method-not-found'],
    [-32603, 'boom (NullPointerException)', 'internal'],
  ] as const)('maps error code %i (%s) to %s', async (code, message, kind) => {
    const daemon = new FakeDaemon().handle('send', () => ({ error: { code, message } }));
    const error = await failure(client(daemon).call('send', {}, unknownValue));
    expect(error.kind).toBe(kind);
    expect(error.code).toBe(code);
    expect(error.message).toBe(message);
  });

  it('turns a send that reached nobody into per-recipient failures', async () => {
    const response = {
      timestamp: 99,
      results: [
        {
          recipientAddress: { uuid: 'u1', number: '+1', username: null },
          type: 'UNREGISTERED_FAILURE',
        },
        {
          recipientAddress: { uuid: null, number: '+2', username: null },
          type: 'RATE_LIMIT_FAILURE',
          retryAfterSeconds: 30,
        },
      ],
    };
    const daemon = new FakeDaemon().handle('send', () => ({
      error: {
        code: -5,
        message: 'Failed to send message due to rate limiting',
        data: { response },
      },
    }));
    const raw = await failure(client(daemon).call('send', {}, wireSendResult));
    const error = enrichSendError(raw) as SignalCliError;
    expect(error.kind).toBe('send-failed');
    expect(error.retryAfterSec).toBe(30);
    expect(error.recipientFailures).toEqual([
      { recipientId: 'u1', reason: 'unregistered' },
      { recipientId: '+2', reason: 'rate-limited' },
    ]);
  });

  it('reports invalid results, non-JSON bodies and HTTP errors as typed errors', async () => {
    const daemon = new FakeDaemon().reply('send', { timestamp: 'soon' });
    expect((await failure(client(daemon).call('send', {}, wireSendResult))).kind).toBe(
      'invalid-response',
    );

    const notJson: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    expect((await failure(client(daemon, notJson).call('x', {}, unknownValue))).kind).toBe(
      'invalid-response',
    );

    const hostRejected: FetchLike = () => Promise.resolve(new Response(null, { status: 421 }));
    const e421 = await failure(client(daemon, hostRejected).call('x', {}, unknownValue));
    expect(e421).toMatchObject({ kind: 'http', status: 421 });
    expect(e421.message).toMatch(/Host header/u);
  });

  it('distinguishes an unreachable daemon from a timeout', async () => {
    const daemon = new FakeDaemon();
    daemon.up = false;
    expect((await failure(client(daemon).check())).kind).toBe('unreachable');

    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const error = await failure(client(daemon, hang).call('x', {}, unknownValue));
    expect(error.kind).toBe('timeout');
    expect(error.transient).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a non-object', 'nope'],
    ['an object with neither result nor error', { id: 1 }],
    ['an error without a code/message', { error: { oops: true } }],
  ] as const)('turns %s transport reply into a protocol error', async (_label, reply) => {
    const rpc = new JsonRpcClient({ transport: rawTransport(reply), timeoutMs: 50 });
    const error = await failure(rpc.call('send', {}, unknownValue));
    expect(error.kind).toBe('protocol');
  });

  it('honours an external abort signal', async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const controller = new AbortController();
    const pending = client(new FakeDaemon(), hang).call('x', {}, unknownValue, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    expect((await failure(pending)).kind).toBe('aborted');
  });
});

describe('whether a failed request was written', () => {
  it('marks a reply whose body is not JSON as requestSent, and a refused connection as not', async () => {
    const daemon = new FakeDaemon();
    const garbled: FetchLike = () => Promise.resolve(new Response('<html>', { status: 200 }));
    const sent = await failure(client(daemon, garbled).call('send', {}, unknownValue));
    expect(sent).toMatchObject({ kind: 'invalid-response', requestSent: true });

    const refused: FetchLike = () => Promise.reject(new TypeError('Failed to fetch'));
    const never = await failure(client(daemon, refused).call('send', {}, unknownValue));
    expect(never).toMatchObject({ kind: 'unreachable', requestSent: false });
  });
});

describe('aborting a call', () => {
  /** A transport whose request never answers until `answer` is called; counts what it was given. */
  function slowTransport() {
    const requests: string[] = [];
    let answer: (reply: unknown) => void = () => undefined;
    const transport: SignalCliTransport = {
      resumeScope: 'test',
      description: 'test transport',
      check: () => Promise.resolve(),
      request: (method) => {
        requests.push(method);
        return new Promise((resolve) => {
          answer = resolve as (reply: unknown) => void;
        });
      },
      subscribe: () => {
        throw new Error('not used in these tests');
      },
    };
    return {
      transport,
      requests,
      answer: (reply: unknown) => {
        answer(reply);
      },
    };
  }

  it('rejects at once with `aborted`, and ignores a reply that arrives afterwards', async () => {
    const slow = slowTransport();
    const rpc = new JsonRpcClient({ transport: slow.transport, timeoutMs: 10_000 });
    const controller = new AbortController();
    const pending = rpc.call('x', {}, unknownValue, { signal: controller.signal });
    await Promise.resolve();
    controller.abort();
    const error = await failure(pending);
    expect(error).toMatchObject({ kind: 'aborted', outcome: 'unknown', transient: false });
    // The late answer neither throws nor resurrects the call.
    slow.answer({ result: { ok: true } });
    await Promise.resolve();
  });

  it('says an aborted mutating call may have been carried out', async () => {
    const slow = slowTransport();
    const rpc = new JsonRpcClient({ transport: slow.transport, timeoutMs: 10_000 });
    const mutating = new AbortController();
    const sent = rpc.call('send', {}, unknownValue, { signal: mutating.signal, mutating: true });
    mutating.abort();
    expect(await failure(sent)).toMatchObject({ kind: 'aborted', outcome: 'maybe-sent' });
  });

  it('sends nothing for a call abandoned before it started', async () => {
    const slow = slowTransport();
    const rpc = new JsonRpcClient({ transport: slow.transport, timeoutMs: 10_000 });
    const controller = new AbortController();
    controller.abort();
    const error = await failure(
      rpc.call('send', {}, unknownValue, { signal: controller.signal, mutating: true }),
    );
    expect(error).toMatchObject({ kind: 'aborted', outcome: 'not-sent' });
    expect(slow.requests).toEqual([]);
  });

  it('still times out when the caller never aborts', async () => {
    const slow = slowTransport();
    const rpc = new JsonRpcClient({ transport: slow.transport, timeoutMs: 20 });
    const controller = new AbortController();
    const error = await failure(rpc.call('x', {}, unknownValue, { signal: controller.signal }));
    expect(error.kind).toBe('timeout');
    // Aborting after the timeout changes nothing.
    controller.abort();
  });

  it('stops the HTTP request itself', async () => {
    let seen: AbortSignal | undefined;
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        seen = init?.signal ?? undefined;
        seen?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const controller = new AbortController();
    const pending = client(new FakeDaemon(), hang).call('x', {}, unknownValue, {
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    controller.abort();
    expect((await failure(pending)).kind).toBe('aborted');
    expect(seen?.aborted).toBe(true);
  });
});
