import { createContext, use, useSyncExternalStore } from 'react';
import type { MessageId } from '@/core/domain';

/**
 * List-wide row state that must be exclusive: only one row is hovered (a
 * row scrolled out from under a still pointer never gets pointerleave, so
 * per-row flags would leave stale hover bars behind), and only one row
 * flashes after a jump. Rows subscribe by id and re-render only when their
 * own flag flips — the virtualiser's rows needn't re-render at all.
 */
export class RowState {
  private hovered: MessageId | null = null;
  private flashing: MessageId | null = null;
  /** The roving tab stop: the one message row reachable with Tab. */
  private active: MessageId | null = null;
  /** A row the user "entered" (Enter): its inner controls are tabbable. */
  private entered: MessageId | null = null;
  private readonly listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  setHovered(id: MessageId | null): void {
    if (this.hovered === id) return;
    this.hovered = id;
    this.emit();
  }

  /** Clears the hover only if it is still `id` (leave events can arrive late). */
  leave(id: MessageId): void {
    if (this.hovered === id) this.setHovered(null);
  }

  isHovered(id: MessageId): boolean {
    return this.hovered === id;
  }

  flash(id: MessageId | null): void {
    if (this.flashing === id) return;
    this.flashing = id;
    this.emit();
  }

  isFlashing(id: MessageId): boolean {
    return this.flashing === id;
  }

  private readonly mounted = new Set<MessageId>();

  /** Rows report mount/unmount so the list knows whether the tab stop is rendered. */
  mount(id: MessageId): () => void {
    this.mounted.add(id);
    this.emit();
    return () => {
      this.mounted.delete(id);
      this.emit();
    };
  }

  /** True when the roving tab stop is a rendered row (else the scroller takes Tab). */
  get activeMounted(): boolean {
    return this.active !== null && this.mounted.has(this.active);
  }

  get activeId(): MessageId | null {
    return this.active;
  }

  setActive(id: MessageId): void {
    if (this.active === id) return;
    this.active = id;
    this.emit();
  }

  isActive(id: MessageId): boolean {
    return this.active === id;
  }

  enter(id: MessageId | null): void {
    if (this.entered === id) return;
    this.entered = id;
    this.emit();
  }

  isEntered(id: MessageId): boolean {
    return this.entered === id;
  }
}

const RowStateContext = createContext<RowState | null>(null);
export const RowStateProvider = RowStateContext.Provider;

/** Standalone rows (tests, previews) get a private state. */
const fallback = new RowState();

export function useRowState(): RowState {
  return use(RowStateContext) ?? fallback;
}

export function useRowHovered(id: MessageId): boolean {
  const rows = useRowState();
  return useSyncExternalStore(rows.subscribe, () => rows.isHovered(id));
}

export function useRowFlashing(id: MessageId): boolean {
  const rows = useRowState();
  return useSyncExternalStore(rows.subscribe, () => rows.isFlashing(id));
}

export function useRowActive(id: MessageId): boolean {
  const rows = useRowState();
  return useSyncExternalStore(rows.subscribe, () => rows.isActive(id));
}

export function useRowEntered(id: MessageId): boolean {
  const rows = useRowState();
  return useSyncExternalStore(rows.subscribe, () => rows.isEntered(id));
}
