/**
 * signal-cli for the desktop app: the Rust side owns it (a `jsonRpc` child
 * on stdin/stdout, or a proxied external daemon) and this transport talks
 * to it over Tauri IPC. Requests are commands; incoming messages and stream
 * state are Tauri events. Cursors are opaque here: the Rust side numbers the
 * events it holds until `acknowledge` (see src-tauri/src/events.rs).
 */
import {
  isRecord,
  SignalCliError,
  type EventStreamState,
  type EventSubscription,
  type EventSubscriptionOptions,
  type RpcParams,
  type RpcReply,
  type SignalCliErrorKind,
  type SignalCliTransport,
  type TransportCallOptions,
} from '@/core/backend/signal-cli';
import type { DesktopConnection } from '@/core/stores';
import {
  asCommandError,
  connectConfig,
  EVENT_RECEIVE,
  EVENT_STATE,
  tauriIpc,
  type CommandError,
  type TauriIpc,
} from './ipc';
import { validateRpcReply } from './ipcValidate';

/** The Rust side's `StreamState`. */
type RustStreamState =
  | { kind: 'connecting'; attempt: number }
  | { kind: 'open' }
  | { kind: 'waiting'; attempt: number; delayMs: number; reason: string }
  | { kind: 'failed'; errorKind: CommandError['kind']; message: string }
  | { kind: 'closed' };

const KINDS: Record<CommandError['kind'], SignalCliErrorKind> = {
  unreachable: 'unreachable',
  timeout: 'timeout',
  'not-installed': 'not-installed',
  config: 'config',
  'invalid-response': 'invalid-response',
  // Only ever returned by the signal-cli *install* commands, never connect/request.
  cancelled: 'internal',
  // Only ever returned by `storage_keyring_status`, never connect/request.
  'keyring-unavailable': 'internal',
  'keyring-locked': 'internal',
  'keyring-corrupt': 'internal',
  // Only ever returned by the storage_* commands (src-tauri/src/storage.rs),
  // never connect/request.
  'keyring-secret-missing': 'internal',
  'auth-failed': 'internal',
  'slot-missing': 'internal',
  'keys-file-corrupt': 'internal',
  'recovery-code-typo': 'internal',
  'vault-corrupt': 'internal',
  'vault-blob-corrupt': 'internal',
  'no-ram-dir': 'internal',
  'already-running': 'internal',
  internal: 'internal',
};

export function toSignalCliError(error: unknown): SignalCliError {
  if (error instanceof SignalCliError) return error;
  const { kind, message } = asCommandError(error);
  return new SignalCliError(KINDS[kind], message, { cause: error });
}

function toStreamState(state: RustStreamState): EventStreamState {
  switch (state.kind) {
    case 'waiting':
      return {
        kind: 'waiting',
        attempt: state.attempt,
        delayMs: state.delayMs,
        error: new SignalCliError('unreachable', state.reason),
      };
    case 'failed':
      return { kind: 'failed', error: new SignalCliError(KINDS[state.errorKind], state.message) };
    default:
      return state;
  }
}

export interface TauriTransportOptions {
  desktop: DesktopConnection;
  ipc?: TauriIpc;
  /** Retry delays for a subscription that couldn't start (signal-cli restarting). */
  retryDelaysMs?: readonly number[];
}

export class TauriTransport implements SignalCliTransport {
  readonly checkTimeoutMs = 90_000;
  private readonly ipc: TauriIpc;
  private readonly config: Record<string, unknown>;

  constructor(private readonly options: TauriTransportOptions) {
    this.ipc = options.ipc ?? tauriIpc;
    this.config = connectConfig(options.desktop);
  }

  get resumeScope(): string {
    return this.options.desktop.mode === 'external' ? 'desktop-external' : 'desktop';
  }

  get description(): string {
    return this.options.desktop.mode === 'external'
      ? `the signal-cli daemon at ${this.options.desktop.externalUrl}`
      : 'signal-cli (run by Snowdrop)';
  }

  async check(_options: TransportCallOptions): Promise<void> {
    try {
      await this.ipc.invoke('signal_cli_connect', { config: this.config });
    } catch (error) {
      throw toSignalCliError(error);
    }
  }

  async request(
    method: string,
    params: RpcParams | undefined,
    options: TransportCallOptions,
  ): Promise<RpcReply> {
    try {
      const raw = await this.ipc.invoke<unknown>('signal_cli_request', {
        method,
        params: params ?? null,
        timeoutMs: options.timeoutMs,
      });
      return validateRpcReply(method, raw);
    } catch (error) {
      throw toSignalCliError(error);
    }
  }

  subscribe(options: EventSubscriptionOptions): EventSubscription {
    return new TauriSubscription(this.ipc, options, this.options.retryDelaysMs);
  }

  acknowledge(cursor: string): void {
    this.ipc.invoke('signal_cli_ack', { cursor }).catch(() => {
      // Only releases memory on the Rust side; a missed ack means a longer hold.
    });
  }
}

const DEFAULT_RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

class TauriSubscription implements EventSubscription {
  private running = false;
  private unlisten: (() => void)[] = [];
  private wake: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  constructor(
    private readonly ipc: TauriIpc,
    private readonly options: EventSubscriptionOptions,
    private readonly retryDelaysMs: readonly number[] = DEFAULT_RETRY_MS,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.wake?.();
    await this.loop;
    for (const off of this.unlisten.splice(0)) off();
    this.options.onState({ kind: 'closed' });
  }

  reconnectNow(): void {
    this.wake?.();
  }

  private isRunning(): boolean {
    return this.running;
  }

  private async run(): Promise<void> {
    // Listen first: the Rust side replays held events while subscribing.
    this.unlisten.push(
      await this.ipc.listen<unknown>(EVENT_RECEIVE, (event) => {
        if (!this.running) return;
        if (!isRecord(event) || typeof event.type !== 'string') {
          console.error('Malformed signal-cli event payload', typeof event);
          return;
        }
        this.options.onEvent({
          type: event.type,
          data: event.data,
          cursor: typeof event.cursor === 'string' ? event.cursor || undefined : undefined,
        });
      }),
      await this.ipc.listen<unknown>(EVENT_STATE, (state) => {
        if (!this.running) return;
        if (!isRecord(state) || typeof state.kind !== 'string') {
          console.error('Malformed signal-cli state payload', typeof state);
          return;
        }
        this.options.onState(toStreamState(state as RustStreamState));
      }),
    );
    for (let attempt = 0; this.isRunning(); attempt++) {
      this.options.onState({ kind: 'connecting', attempt });
      try {
        await this.ipc.invoke('signal_cli_subscribe', {
          account: this.options.account,
          resumeFrom: this.options.resumeFrom,
        });
        // `stop()` may have run while the invoke above was in flight: it
        // already emitted `closed`, so don't flicker back to `open`.
        if (this.isRunning()) this.options.onState({ kind: 'open' });
        return;
      } catch (error) {
        const failure = toSignalCliError(error);
        if (failure.kind === 'not-installed' || failure.kind === 'config') {
          this.options.onState({ kind: 'failed', error: failure });
          this.running = false;
          return;
        }
        const delayMs =
          this.retryDelaysMs[Math.min(attempt, this.retryDelaysMs.length - 1)] ?? 1_000;
        this.options.onState({ kind: 'waiting', attempt, delayMs, error: failure });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(done, delayMs);
          function done(): void {
            clearTimeout(timer);
            resolve();
          }
          this.wake = done;
        });
        this.wake = null;
      }
    }
  }
}
