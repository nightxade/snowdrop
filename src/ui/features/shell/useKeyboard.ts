import { useEffect } from 'react';
import { describeFocus, useSnowdrop } from '@/ui/hooks';

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(
      target.type,
    );
  }
  return false;
}

/**
 * The global keyboard listeners.
 *
 * Capture phase: plugin key layers (Vim mode) get first refusal, before the
 * focused widget's own handlers; a consumed key is prevented and stopped.
 * With no layer installed this does nothing.
 *
 * Bubble phase: the keybind dispatcher. It ignores events something else
 * already handled (Radix layers preventDefault the Escape that closes them),
 * so Escape closes a menu first and only marks the conversation read when
 * nothing's open.
 */
export function useKeyboard(): void {
  const { keybinds, stores, registries } = useSnowdrop();
  useEffect(() => {
    const layers = registries.keyLayers;
    const onCapture = (event: KeyboardEvent) => {
      if (event.defaultPrevented || layers.layers().length === 0) return;
      const ctx = describeFocus(document, stores.ui.getState().modal !== null);
      if (layers.handle(event, ctx)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Dialogs own the keyboard while open.
      if (stores.ui.getState().modal && event.key === 'Escape') return;
      const handled = keybinds.handle(event, { inEditable: isEditableTarget(event.target) });
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onCapture, true);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onCapture, true);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [keybinds, stores, registries]);
}
