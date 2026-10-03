// @vitest-environment node
/**
 * The transport seam: JsonRpcClient and SignalCliBackend against a fake
 * `SignalCliTransport` (no HTTP, no SSE), the way the desktop transport
 * plugs in.
 */
import { describe, expect, it, vi } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { SignalCliError } from './errors';
import { dataMessage, receive, SELF_ACI, SELF_NUMBER, T0 } from './fixtures/envelopes';
import { JsonRpcClient } from './rpc';
import { SignalCliBackend } from './SignalCliBackend';
import type {
  EventStreamState,
  EventSubscriptionOptions,
  RpcParams,
  RpcReply,
  SignalCliTransport,
  TransportCallOptions,
} from './transport';
import { unknownValue } from './validate';

type Handler = (
  params: RpcParams | undefined,
  options: TransportCallOptions,
) => Promise<RpcReply> | RpcReply;

/** A scriptable transport: canned replies per method, a pushable event subscription. */
class FakeTransport implements SignalCliTransport {
  readonly resumeScope = 'fake';
  readonly description = 'the fake signal-cli';
  readonly calls: { method: string; params: RpcParams | undefined }[] = [];
  readonly subscriptions: EventSubscriptionOptions[] = [];
  readonly acks: string[] = [];
  checks = 0;
  stopped = 0;
  handlers: Record<string, Handler> = {
    listAccounts: () => ({ result: [{ number: SELF_NUMBER, aci: SELF_ACI }] }),
    listGroups: () => ({ result: [] }),
    listContacts: () => ({ result: [] }),
  };

  check(): Promise<void> {
    this.checks++;
    return Promise.resolve();
  }

  async request(method: string, params: RpcParams | undefined, options: TransportCallOptions) {
    this.calls.push({ method, params });
    const handler = this.handlers[method];
    if (!handler) return { error: { code: -32601, message: 'Method not implemented' } };
    return handler(params, options);
  }

  subscribe(options: EventSubscriptionOptions) {
    this.subscriptions.push(options);
    return {
      start: () => {
        options.onState({ kind: 'open' });
      },
      stop: () => {
        this.stopped++;
        return Promise.resolve();
      },
      reconnectNow: () => undefined,
    };
  }

  acknowledge(cursor: string): void {
    this.acks.push(cursor);
  }

  /** Delivers an event on the latest subscription. */
  push(data: unknown, cursor?: string): void {
    this.subscriptions.at(-1)?.onEvent({ type: 'receive', data, cursor });
  }

  state(state: EventStreamState): void {
    this.subscriptions.at(-1)?.onState(state);
  }
}

describe('JsonRpcClient over a transport', () => {
  it('injects the account, opts out with null, and decodes results', async () => {
    const transport = new FakeTransport();
    transport.handlers.version = () => ({ result: { version: '0.14.8' } });
    const rpc = new JsonRpcClient({ transport });
    rpc.account = SELF_ACI;
    await rpc.call('version', { a: 1 }, unknownValue);
    await rpc.call('listAccounts', undefined, unknownValue, { account: null });
    expect(transport.calls).toEqual([
      { method: 'version', params: { a: 1, account: SELF_ACI } },
      { method: 'listAccounts', params: undefined },
    ]);
  });

  it('turns error replies into typed errors', async () => {
    const transport = new FakeTransport();
    transport.handlers.send = () => ({ error: { code: -5, message: 'Rate limit exceeded' } });
    const rpc = new JsonRpcClient({ transport });
    await expect(rpc.call('send', {}, unknownValue)).rejects.toMatchObject({
      kind: 'rate-limited',
      code: -5,
    });
    await expect(rpc.call('nope', {}, unknownValue)).rejects.toMatchObject({
      kind: 'method-not-found',
    });
  });

  it('enforces the deadline even when the transport cannot cancel', async () => {
    vi.useFakeTimers();
    try {
      const transport = new FakeTransport();
      const seen: AbortSignal[] = [];
      transport.handlers.slow = (_p, { signal }) => {
        seen.push(signal);
        return new Promise<RpcReply>(() => undefined); // never answers
      };
      const rpc = new JsonRpcClient({ transport, timeoutMs: 1_000 });
      const call = rpc.call('slow', {}, unknownValue);
      const assertion = expect(call).rejects.toMatchObject({ kind: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_000);
      await assertion;
      expect(seen[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports an external abort as aborted', async () => {
    const transport = new FakeTransport();
    transport.handlers.slow = () => new Promise<RpcReply>(() => undefined);
    const rpc = new JsonRpcClient({ transport });
    const controller = new AbortController();
    const call = rpc.call('slow', {}, unknownValue, { signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('keeps a transport’s own typed failures and wraps anything else as unreachable', async () => {
    const transport = new FakeTransport();
    transport.handlers.missing = () => {
      throw new SignalCliError('not-installed', 'signal-cli wasn’t found');
    };
    transport.handlers.broken = () => {
      throw new Error('pipe closed');
    };
    const rpc = new JsonRpcClient({ transport });
    await expect(rpc.call('missing', {}, unknownValue)).rejects.toMatchObject({
      kind: 'not-installed',
    });
    await expect(rpc.call('broken', {}, unknownValue)).rejects.toMatchObject({
      kind: 'unreachable',
      message: 'Cannot reach the fake signal-cli',
    });
  });
});

describe('SignalCliBackend over a transport', () => {
  function setup() {
    const transport = new FakeTransport();
    const storage = createMemoryStorage();
    const backend = new SignalCliBackend({
      baseUrl: '/unused',
      transport,
      storage,
      scheduler: new ManualScheduler(T0),
      debug: () => undefined,
    });
    return { transport, storage, backend };
  }

  it('checks, picks the account and subscribes for it with the stored cursor', async () => {
    const { transport, storage, backend } = setup();
    storage.setItem(`snowdrop.signal-cli.cursor.fake.${SELF_ACI}`, 'run1:41');
    await backend.connect();
    expect(transport.checks).toBe(1);
    expect(transport.subscriptions).toHaveLength(1);
    expect(transport.subscriptions[0]).toMatchObject({ account: SELF_ACI, resumeFrom: 'run1:41' });
    expect(backend.getStatus()).toBe('online');
  });

  it('subscribes without an account on a single-account signal-cli', async () => {
    const { transport, backend } = setup();
    delete transport.handlers.listAccounts;
    const single = new SignalCliBackend({
      baseUrl: '/unused',
      transport,
      account: SELF_NUMBER,
      debug: () => undefined,
    });
    await single.connect();
    expect(transport.subscriptions.at(-1)?.account).toBeNull();
    await backend.disconnect();
  });

  it('accepts parsed payloads (IPC) as well as text (SSE), and acknowledges through the transport', async () => {
    const { transport, storage, backend } = setup();
    const messages: string[] = [];
    const checkpoints: string[] = [];
    backend.on('message', (m) => messages.push(m.body));
    backend.on('checkpoint', ({ cursor }) => checkpoints.push(cursor));
    await backend.connect();
    transport.push(receive('alice', { dataMessage: dataMessage({ message: 'parsed' }) }), 'r:1');
    transport.push(
      JSON.stringify(
        receive('alice', { dataMessage: dataMessage({ message: 'text', timestamp: T0 + 1 }) }),
      ),
      'r:2',
    );
    await backend.idle();
    expect(messages).toEqual(['parsed', 'text']);
    expect(checkpoints).toEqual(['r:1', 'r:2']);
    backend.acknowledge('r:2');
    expect(storage.getItem(`snowdrop.signal-cli.cursor.fake.${SELF_ACI}`)).toBe('r:2');
    expect(transport.acks).toEqual(['r:2']);
  });

  it('maps a failed stream (signal-cli missing) to an error status a retry can recover from', async () => {
    const { transport, backend } = setup();
    await backend.connect();
    transport.state({ kind: 'failed', error: new SignalCliError('not-installed', 'gone') });
    expect(backend.getStatus()).toBe('error');
    await backend.connect();
    expect(transport.subscriptions).toHaveLength(2);
  });
});
