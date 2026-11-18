import { useSyncExternalStore } from 'react';

/**
 * Whether Shift is held. One shared set of window listeners, attached only
 * while some component (the active hover bar) cares.
 *
 * A held Shift sends no further key events, so pointer events (which carry
 * the modifier state too) keep it current: after a Shift+click delete
 * unmounts the last hover bar, the next row's bar learns Shift is still down
 * as soon as the pointer moves onto it.
 */
let held = false;
const listeners = new Set<() => void>();

function set(next: boolean): void {
  if (held === next) return;
  held = next;
  for (const fn of listeners) fn();
}

const onInput = (e: KeyboardEvent | PointerEvent) => {
  set(e.shiftKey);
};
const onBlur = () => {
  set(false);
};

function subscribe(fn: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener('keydown', onInput);
    window.addEventListener('keyup', onInput);
    window.addEventListener('pointermove', onInput, { passive: true });
    window.addEventListener('pointerdown', onInput);
    window.addEventListener('blur', onBlur);
  }
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
    if (listeners.size === 0) {
      window.removeEventListener('keydown', onInput);
      window.removeEventListener('keyup', onInput);
      window.removeEventListener('pointermove', onInput);
      window.removeEventListener('pointerdown', onInput);
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
