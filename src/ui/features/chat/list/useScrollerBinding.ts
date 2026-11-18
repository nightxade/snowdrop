import { useCallback, useEffect, useRef } from 'react';
import type { RowState } from './rowState';

interface Options {
  rows: RowState;
  onScroll: () => void;
  /** Called when the viewport height changes (e.g. the composer grew). */
  onResize: () => void;
  /** Called on the reader's own input to the list (wheel, touch, a key, a press on the scroll bar). */
  onReaderInput: () => void;
}

/** Input with which the reader moves the list themselves (a key inside it included; see `inputListener`). */
const READER_INPUT = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const;

/**
 * Owns the virtualiser's scroller element: a stable ref callback (Virtuoso
 * calls it again whenever its identity changes, and per-render reattachment
 * used to reset the bottom pin, yanking a reader who had scrolled up back
 * down), the scroll listener, the viewport ResizeObserver and the scroller's
 * tab stop. The handlers may change every render; the latest are used.
 */
export function useScrollerBinding({ rows, onScroll, onResize, onReaderInput }: Options) {
  const scroller = useRef<HTMLElement | null>(null);
  const resize = useRef<ResizeObserver | null>(null);
  const handlers = useRef({ onScroll, onResize, onReaderInput });
  useEffect(() => {
    handlers.current = { onScroll, onResize, onReaderInput };
  });
  const scrollListener = useCallback(() => {
    handlers.current.onScroll();
  }, []);
  const inputListener = useCallback((e: Event) => {
    // A press on a message is not moving the list; one on the scroller itself is its scroll bar.
    if (e.type === 'pointerdown' && e.target !== e.currentTarget) return;
    handlers.current.onReaderInput();
  }, []);

  const scrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      const node = el instanceof HTMLElement ? el : null;
      if (scroller.current === node) return;
      scroller.current?.removeEventListener('scroll', scrollListener);
      for (const type of READER_INPUT)
        scroller.current?.removeEventListener(type, inputListener, { capture: true });
      resize.current?.disconnect();
      resize.current = null;
      scroller.current = node;
      if (!node) return;
      node.tabIndex = rows.activeMounted ? -1 : 0;
      // Stable hook for keyboard layers ("focus is on the message list").
      node.setAttribute('data-message-scroller', '');
      node.addEventListener('scroll', scrollListener, { passive: true });
      for (const type of READER_INPUT)
        node.addEventListener(type, inputListener, { passive: true, capture: true });
      // The viewport shrinks when the composer grows (reply bar, more lines,
      // attachments): keep the newest message in view if we were holding it.
      let height = node.clientHeight;
      if (typeof ResizeObserver !== 'undefined') {
        resize.current = new ResizeObserver(() => {
          if (node.clientHeight === height) return;
          height = node.clientHeight;
          handlers.current.onResize();
        });
        resize.current.observe(node);
      }
    },
    [scrollListener, inputListener, rows],
  );

  // When no rendered row holds the roving tab stop, the scroller itself takes Tab.
  useEffect(
    () =>
      rows.subscribe(() => {
        if (scroller.current) scroller.current.tabIndex = rows.activeMounted ? -1 : 0;
      }),
    [rows],
  );

  useEffect(
    () => () => {
      scroller.current?.removeEventListener('scroll', scrollListener);
      for (const type of READER_INPUT)
        scroller.current?.removeEventListener(type, inputListener, { capture: true });
      resize.current?.disconnect();
    },
    [scrollListener, inputListener],
  );

  /** Where the scroller stands now (undefined until it mounts). */
  const scrollTopNow = useCallback(() => scroller.current?.scrollTop, []);

  return { scroller, scrollerRef, scrollTopNow };
}
