/**
 * Collects cleanup functions and runs them in reverse order. Used by plugin
 * contexts and services so "stop" can never leak a subscription.
 *
 * Every disposer runs at most once, whether it's triggered through its own
 * handle, through `dispose()`, or both.
 */
import { createLogger } from './log';

export type Disposer = () => void;

interface Entry {
  fn: Disposer;
  done: boolean;
}

export class DisposableStore {
  private entries: Entry[] = [];
  private disposed = false;

  constructor(private readonly onError: (error: unknown) => void = defaultOnError) {}

  /** Registers a disposer; if already disposed it runs immediately. */
  add(fn: Disposer): Disposer {
    const entry: Entry = { fn, done: false };
    if (this.disposed) {
      this.run(entry);
      return () => undefined;
    }
    this.entries.push(entry);
    return () => {
      this.entries = this.entries.filter((e) => e !== entry);
      this.run(entry);
    };
  }

  get size(): number {
    return this.entries.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const list = this.entries.reverse();
    this.entries = [];
    for (const entry of list) this.run(entry);
  }

  private run(entry: Entry): void {
    if (entry.done) return;
    entry.done = true;
    try {
      entry.fn();
    } catch (error) {
      this.onError(error);
    }
  }
}

const log = createLogger('app');

function defaultOnError(error: unknown): void {
  log.error('disposer failed', error);
}
