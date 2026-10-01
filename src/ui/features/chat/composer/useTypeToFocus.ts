import { useEffect, type RefObject } from 'react';
import { useStores } from '@/ui/hooks';

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  return (
    el instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(el.type)
  );
}

/**
 * Typing a printable character while nothing text-like has focus sends it
 * to the composer (PLAN §4.11). Menus, dialogs and listboxes keep their own
 * typeahead, and keys something else already handled are left alone.
 */
export function useTypeToFocus(target: RefObject<HTMLTextAreaElement | null>): void {
  const stores = useStores();
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      // Printable = one character (named keys like "Shift" or "F1" are longer). Space stays with buttons.
      const printable =
        e.key.length === 1 || (e.key.length === 2 && (e.key.codePointAt(0) ?? 0) > 0xffff);
      if (!printable || e.key === ' ') return;
      if (stores.ui.getState().modal) return;
      const active = document.activeElement;
      if (isEditable(active)) return;
      if (active?.closest('[role="menu"],[role="dialog"],[role="listbox"],[role="alertdialog"]'))
        return;
      // Focusing during keydown lets the browser insert the character into the textarea.
      target.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [stores, target]);
}
