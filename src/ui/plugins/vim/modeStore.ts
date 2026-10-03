import type { Mode } from './engine/engine';

export interface ModeSnapshot {
  /** Null until the composer has been used (the pill shows the start mode). */
  mode: Mode | null;
  /** Keys typed so far ("d2", "g", "Space"), like Vim's showcmd. */
  pending: string;
  /** The engine's cursor (UTF-16 offset): where the block cursor sits, the moving end in Visual mode. */
  cursor: number;
}

const EMPTY: ModeSnapshot = { mode: null, pending: '', cursor: 0 };

/**
 * What the mode pill and block cursor show, per composer (surface id = conversation id),
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

  set(id: string, mode: Mode, pending: string, cursor = 0): void {
    const current = this.byId.get(id);
    if (current?.mode === mode && current.pending === pending && current.cursor === cursor) return;
    this.byId.set(id, { mode, pending, cursor });
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
