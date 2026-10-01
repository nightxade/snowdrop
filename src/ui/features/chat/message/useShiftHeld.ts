import { useSyncExternalStore } from 'react';

/**
 * Whether Shift is held. One shared set of window listeners, attached only
 * while some component (the active hover bar) cares.
 */
let held = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (held === next) return;
  held = next;
  for (const fn of listeners) fn();
}

const onKey = (e: KeyboardEvent) => {
  set(e.shiftKey);
};
const onBlur = () => {
  set(false);
};

function subscribe(fn: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', onBlur);
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      held = false;
    }
  };
}

export function useShiftHeld(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => held,
    () => false,
  );
}

/** For event handlers: Shift state of the current pointer/keyboard event. */
export function isShiftHeld(): boolean {
  return held;
}
