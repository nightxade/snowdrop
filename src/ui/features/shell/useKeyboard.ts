import { useEffect } from 'react';
import { useHearth } from '@/ui/hooks';

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
 * The single global keydown listener feeding the keybind dispatcher. It runs
 * in the bubble phase and ignores events something else already handled
 * (Radix layers preventDefault the Escape that closes them), so Escape closes
 * a menu first and only marks the conversation read when nothing's open.
 */
export function useKeyboard(): void {
  const { keybinds, stores } = useHearth();
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // Dialogs own the keyboard while open.
      if (stores.ui.getState().modal && event.key === 'Escape') return;
      const handled = keybinds.handle(event, { inEditable: isEditableTarget(event.target) });
      if (handled) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [keybinds, stores]);
}
