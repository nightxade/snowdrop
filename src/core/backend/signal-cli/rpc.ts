/**
 * JSON-RPC 2.0 client for signal-cli, over any `SignalCliTransport`
 * (the HTTP daemon in the browser, Tauri IPC in the desktop app).
 *
 * Every result is validated with a decoder before it leaves this module, and
 * every failure becomes a `SignalCliError` with a machine-readable kind.
 * In multi-account mode single-account methods need an `account` param; the
 * client injects the selected account unless a call opts out (`account: null`
 * for startLink/finishLink/listAccounts).
 */
import { kindForRpcCode, SignalCliError } from './errors';
import { HttpTransport, type FetchLike } from './httpTransport';
import type { RpcParams, RpcReply, SignalCliTransport, TransportCallOptions } from './transport';
import { decode, isRecord, type Decoder } from './validate';

export { joinUrl, type FetchLike } from './httpTransport';
export type { RpcParams } from './transport';

export type JsonRpcClientOptions = {
  /** Default per-call timeout. */
  timeoutMs?: number;
} & (
  | { transport: SignalCliTransport }
  /** Shorthand for an `HttpTransport`. */
  | { baseUrl: string; fetch?: FetchLike }
);

export interface CallOptions {
  /** Overrides the client's account; `null` sends no account param. */
  account?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class JsonRpcClient {
  /** Account injected into single-account calls (ACI or number). */
  account: string | undefined;
  readonly transport: SignalCliTransport;
  private readonly timeoutMs: number;

  constructor(options: JsonRpcClientOptions) {
    this.transport =
      'transport' in options
        ? options.transport
        : new HttpTransport({
            baseUrl: options.baseUrl,
            ...(options.fetch ? { fetch: options.fetch } : {}),
          });
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** Resolves when signal-cli is up (the HTTP daemon's /api/v1/check; the desktop starts it). */
  check(options: Pick<CallOptions, 'timeoutMs' | 'signal'> = {}): Promise<void> {
    return this.withDeadline(options, (call) => this.transport.check(call));
  }

  async call<T>(
    method: string,
    params: RpcParams | undefined,
    decoder: Decoder<T>,
    options: CallOptions = {},
  ): Promise<T> {
    const account = options.account === undefined ? this.account : options.account;
    const allParams: RpcParams = { ...params };
    if (account !== null && account !== undefined) allParams.account = account;
    const rawReply = await this.withDeadline(options, (call) =>
      this.transport.request(
        method,
        Object.keys(allParams).length > 0 ? allParams : undefined,
        call,
      ),
    );
    const reply = validateReply(method, rawReply);
    if (reply.error) {
      const { code, message } = reply.error;
      throw new SignalCliError(kindForRpcCode(code, message), message, {
        code,
        data: reply.error.data ?? undefined,
      });
    }
    const result = decode(decoder, reply.result);
    if (!result.ok) {
      throw new SignalCliError('invalid-response', `${method}: ${result.error.message}`, {
        cause: result.error,
      });
    }
    return result.value;
  }

  /**
   * Runs a transport call with a timeout and the caller's abort signal. The
   * deadline is enforced here, whether or not the transport can cancel.
   */
  private async withDeadline<T>(
    options: Pick<CallOptions, 'timeoutMs' | 'signal'>,
    run: (call: TransportCallOptions) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const external = options.signal;
    const failure = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new SignalCliError('timeout', `signal-cli did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      const onAbort = (): void => {
        controller.abort();
        reject(new SignalCliError('aborted', 'Request aborted'));
      };
      if (external?.aborted) onAbort();
      else external?.addEventListener('abort', onAbort, { once: true });
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        external?.removeEventListener('abort', onAbort);
      });
    });
    // Unhandled-rejection guard: `failure` may settle after the call won.
    failure.catch(() => undefined);
    try {
      return await Promise.race([run({ signal: controller.signal, timeoutMs }), failure]);
    } catch (error) {
      if (controller.signal.aborted) {
        // An abort or the timeout rejected `failure`; prefer that over the
        // transport's own AbortError.
        await failure.catch((reason: unknown) => {
          throw reason;
        });
      }
      if (error instanceof SignalCliError) throw error;
      throw new SignalCliError('unreachable', `Cannot reach ${this.transport.description}`, {
        cause: error,
      });
    } finally {
      controller.abort();
    }
  }
}

/**
 * Validates a transport's raw reply before the client trusts its shape.
 * `SignalCliTransport.request` is an interface any transport can implement
 * (the HTTP daemon, Tauri IPC, a test double); a bug or a version skew on
 * either side can hand back `undefined`, `null`, or an object with neither
 * `result` nor `error`. Rather than let `reply.error` throw a raw
 * TypeError, that becomes a typed `SignalCliError` with kind `'protocol'`.
 */
function validateReply(method: string, reply: unknown): RpcReply {
  if (!isRecord(reply)) {
    throw new SignalCliError('protocol', `${method}: malformed reply from transport`, {
      data: reply,
    });
  }
  if (reply.error !== undefined && reply.error !== null) {
    const error = reply.error;
    if (!isRecord(error) || typeof error.code !== 'number' || typeof error.message !== 'string') {
      throw new SignalCliError('protocol', `${method}: malformed error in transport reply`, {
        data: reply,
      });
    }
    return { error: { code: error.code, message: error.message, data: error.data } };
  }
  if ('result' in reply) {
    return { result: reply.result };
  }
  throw new SignalCliError(
    'protocol',
    `${method}: transport reply has neither a result nor an error`,
    { data: reply },
  );
}
