import { createLogger, describeError, type Unsubscribe } from '@/core/lib';
import type { BackendCapabilities, Feature } from './types';

/**
 * A backend's `capabilities`: a set of `Feature`s that can change (the
 * version-dependent ones are only known after `connect()`).
 *
 * The set is replaced, never edited in place, and only when its contents
 * actually change, so `features` is a stable reference between changes and a
 * subscriber is told exactly once per change.
 */
const log = createLogger('backend');

export class FeatureStore implements BackendCapabilities {
  private current: ReadonlySet<Feature>;
  private readonly listeners = new Set<() => void>();

  constructor(initial: Iterable<Feature> = []) {
    this.current = new Set(initial);
  }

  get features(): ReadonlySet<Feature> {
    return this.current;
  }

  subscribe(fn: () => void): Unsubscribe {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Replaces the set; a no-op (and no notification) when nothing differs. */
  set(next: Iterable<Feature>): void {
    const features = new Set(next);
    if (features.size === this.current.size && [...features].every((f) => this.current.has(f)))
      return;
    this.current = features;
    // A failing listener must not abort whoever changed the set (e.g. connect).
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (error) {
        log.error('features listener failed', describeError(error));
      }
    }
  }

  /** Turns one feature on or off (tests and the demo backend). */
  setFeature(feature: Feature, on: boolean): void {
    const next = new Set(this.current);
    if (on) next.add(feature);
    else next.delete(feature);
    this.set(next);
  }
}
