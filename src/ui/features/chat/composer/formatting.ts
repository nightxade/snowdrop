import type { KeyboardEvent } from 'react';

/** Ctrl/Cmd+B bold, +I italic, +Shift+X strikethrough: the markers each shortcut wraps with. */
export function formattingMarker(e: {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}): string | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  const key = e.key.toLowerCase();
  if (!e.shiftKey && key === 'b') return '**';
  if (!e.shiftKey && key === 'i') return '*';
  if (e.shiftKey && key === 'x') return '~~';
  return null;
}

/**
 * Handles a formatting shortcut in a textarea: wraps the selection in the
 * marker (or unwraps it if already wrapped); with nothing selected, inserts
 * a pair and puts the caret between. Returns whether the key was handled.
 */
export function wrapSelection(
  e: KeyboardEvent<HTMLTextAreaElement>,
  apply: (start: number, end: number, text: string, selStart: number, selEnd: number) => void,
): boolean {
  const marker = formattingMarker(e);
  if (!marker) return false;
  const el = e.currentTarget;
  const { selectionStart: start, selectionEnd: end, value } = el;
  const selected = value.slice(start, end);
  const m = marker.length;
  const wrapped =
    value.slice(Math.max(0, start - m), start) === marker && value.slice(end, end + m) === marker;
  if (wrapped) {
    apply(start - m, end + m, selected, start - m, end - m);
  } else {
    apply(start, end, `${marker}${selected}${marker}`, start + m, end + m);
  }
  return true;
}
