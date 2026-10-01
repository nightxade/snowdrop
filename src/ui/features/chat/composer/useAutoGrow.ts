import { useLayoutEffect, type RefObject } from 'react';

/** Grows a textarea with its content up to `maxHeight` (CSS length), then it scrolls. */
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  maxHeight = '50vh',
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.maxHeight = maxHeight;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [ref, value, maxHeight]);
}

/**
 * Replaces text[start, end) through the browser's editing pipeline so the
 * change joins the native undo stack; falls back to a plain value change.
 * Returns the new value.
 */
export function replaceRange(
  el: HTMLTextAreaElement,
  start: number,
  end: number,
  text: string,
  selectStart = start + text.length,
  selectEnd = selectStart,
): string {
  el.focus();
  el.setSelectionRange(start, end);
  let done: boolean;
  try {
    // Deprecated, but still the only way to keep native undo for textareas.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    done = document.execCommand('insertText', false, text);
  } catch {
    done = false;
  }
  if (!done || el.value.slice(start, start + text.length) !== text) {
    el.setRangeText(text, start, end, 'end');
  }
  el.setSelectionRange(selectStart, selectEnd);
  return el.value;
}
