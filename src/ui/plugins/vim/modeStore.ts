import type { Mode } from './engine/engine';

export interface ModeSnapshot {
  /** Null until the composer has been used (the pill shows the start mode). */
  mode: Mode | null;
  /** Keys typed so far ("d2", "g", "Space"), like Vim's showcmd. */
  pending: string;
}

const EMPTY: ModeSnapshot = { mode: null, pending: '' };

/**
 * What the mode pill shows, per composer (surface id = conversation id),
 * plus the navigation layer's pending keys. Tiny observable so the pill can
 * use useSyncExternalStore; snapshots are stable until they change.
 */
export class ModeStore {
  private readonly byId = new Map<string, ModeSnapshot>();
  private navPending = '';
  private readonly listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  get(id: string): ModeSnapshot {
    return this.byId.get(id) ?? EMPTY;
  }

  get nav(): string {
    return this.navPending;
  }

  set(id: string, mode: Mode, pending: string): void {
    const current = this.byId.get(id);
    if (current?.mode === mode && current.pending === pending) return;
    this.byId.set(id, { mode, pending });
    this.emit();
  }

  setNavPending(pending: string): void {
    if (this.navPending === pending) return;
    this.navPending = pending;
    this.emit();
  }

  clear(): void {
    this.byId.clear();
    this.navPending = '';
    this.emit();
  }

  private emit(): void {
    for (const fn of [...this.listeners]) fn();
  }
}
