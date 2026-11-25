import { useEffect } from 'react';

/** A field that takes a caret through `setSelectionRange`. */
function caretField(el: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (el instanceof HTMLTextAreaElement) return el;
  if (
    el instanceof HTMLInputElement &&
    ['text', 'search', 'url', 'tel', 'password', ''].includes(el.type)
  )
    return el;
  return null;
}

/**
 * Gives a clicked text field its caret when the click left it without one. Above 100% zoom (the
 * Zoom setting, or WebKit's own page zoom), a click that moves focus into a textarea or input
 * focuses it without placing a selection in WebKitGTK, so typed keys insert nothing. When that
 * happens the caret goes to the end of the text, as a programmatic focus would put it.
 */
export function useCaretOnClick(): void {
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const field = caretField(document.activeElement);
      if (!field || !(e.target instanceof Node) || !field.contains(e.target)) return;
      if ((document.getSelection()?.rangeCount ?? 0) > 0) return;
      const end = field.value.length;
      field.setSelectionRange(end, end);
    };
    document.addEventListener('mouseup', onMouseUp);
    return () => {
      document.removeEventListener('mouseup', onMouseUp);
    };
  }, []);
}
