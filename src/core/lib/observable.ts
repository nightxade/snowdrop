/**
 * An observable, ordered collection with stable snapshots.
 *
 * `list()` returns the same array instance until the collection changes, which
 * makes it safe to use directly with React's useSyncExternalStore (the UI
 * layer) while staying framework-agnostic here.
 */
import type { Disposer } from './disposables';
import type { Unsubscribe } from './emitter';

export class ObservableList<T> {
  private items: readonly T[] = [];
  private readonly subscribers = new Set<() => void>();

  add(item: T): Disposer {
    this.items = [...this.items, item];
    this.notify();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.items = this.items.filter((i) => i !== item);
      this.notify();
    };
  }

  list(): readonly T[] {
    return this.items;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private notify(): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn();
      } catch (error) {
        console.error('[snowdrop] registry subscriber failed', error);
      }
    }
  }
}
