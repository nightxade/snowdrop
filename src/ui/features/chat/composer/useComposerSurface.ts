import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { TextSurface } from '@/core/commands';
import { registerTextSurface } from '@/ui/hooks';
import { replaceRange } from './useAutoGrow';

export interface ComposerSurfaceOptions {
  textarea: RefObject<HTMLTextAreaElement | null>;
  /** Surface id: per-conversation state (Vim mode, undo) is keyed by it. */
  id: string;
  setText: (text: string) => void;
  syncCaret: () => void;
  submit: () => void;
  escape: () => 'reply' | 'read' | 'none';
}

/** Smallest replaced span between two strings, never splitting a surrogate pair. */
export function diffSpan(
  before: string,
  after: string,
): { start: number; end: number; insert: string } {
  let p = 0;
  const max = Math.min(before.length, after.length);
  while (p < max && before[p] === after[p]) p++;
  if (p > 0 && /[\uD800-\uDBFF]/u.test(before.charAt(p - 1))) p--;
  let q = 0;
  while (q < max - p && before[before.length - 1 - q] === after[after.length - 1 - q]) q++;
  if (q > 0 && /[\uDC00-\uDFFF]/u.test(before.charAt(before.length - q))) q--;
  return { start: p, end: before.length - q, insert: after.slice(p, after.length - q) };
}

/**
 * Exposes the composer's textarea to key layers (Vim mode) as a TextSurface:
 * edits go through the browser's editing pipeline (native undo, React
 * onChange), and suggestions can be paused outside Insert mode. Returns
 * whether suggestions are currently enabled.
 */
export function useComposerSurface(options: ComposerSurfaceOptions): boolean {
  const [suggestions, setSuggestions] = useState(true);
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });

  const { textarea, id } = options;
  useLayoutEffect(() => {
    const el = textarea.current;
    if (!el) return;
    const surface: TextSurface = {
      id,
      read: () => ({
        text: el.value,
        selectionStart: el.selectionStart,
        selectionEnd: el.selectionEnd,
      }),
      write: ({ text, selectionStart, selectionEnd }) => {
        if (text !== el.value) {
          const span = diffSpan(el.value, text);
          latest.current.setText(
            replaceRange(el, span.start, span.end, span.insert, selectionStart, selectionEnd),
          );
        } else {
          el.setSelectionRange(selectionStart, selectionEnd);
        }
        latest.current.syncCaret();
      },
      submit: () => {
        latest.current.submit();
      },
      escape: () => latest.current.escape(),
      setSuggestionsEnabled: setSuggestions,
    };
    const unregister = registerTextSurface(el, surface);
    return () => {
      unregister();
      setSuggestions(true);
    };
  }, [textarea, id]);

  return suggestions;
}
