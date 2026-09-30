/**
 * Collects cleanup functions and runs them in reverse order. Used by plugin
 * contexts and services so "stop" can never leak a subscription.
 */

export type Disposer = () => void;

export class DisposableStore {
  private disposers: Disposer[] = [];
  private disposed = false;

  /** Registers a disposer; if already disposed it runs immediately. */
  add(disposer: Disposer): Disposer {
    if (this.disposed) {
      safeRun(disposer, this.onError);
      return () => undefined;
    }
    this.disposers.push(disposer);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.disposers = this.disposers.filter((d) => d !== disposer);
      safeRun(disposer, this.onError);
    };
  }

  constructor(private readonly onError: (error: unknown) => void = defaultOnError) {}

  get size(): number {
    return this.disposers.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const list = this.disposers.reverse();
    this.disposers = [];
    for (const d of list) safeRun(d, this.onError);
  }
}

function safeRun(fn: Disposer, onError: (error: unknown) => void): void {
  try {
    fn();
  } catch (error) {
    onError(error);
  }
}

function defaultOnError(error: unknown): void {
  console.error('[hearth] disposer failed', error);
}
