import { useEffect, type RefObject } from 'react';
import { describeFocus, useStores } from '@/ui/hooks';

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
      // Same rules as the key layers: an overlay that owns the keyboard, or any text field, keeps it.
      const focus = describeFocus(document, stores.ui.getState().modal !== null);
      if (focus.overlay || focus.target === 'input' || focus.target === 'composer') return;
      // Focusing during keydown lets the browser insert the character into the textarea.
      target.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [stores, target]);
}
