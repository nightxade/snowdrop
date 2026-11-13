import { useCallback, useEffect, useRef } from 'react';
import type { RowState } from './rowState';

interface Options {
  rows: RowState;
  onScroll: () => void;
  /** Called when the viewport height changes (e.g. the composer grew). */
  onResize: () => void;
}

/**
 * Owns the virtualiser's scroller element: a stable ref callback (Virtuoso
 * calls it again whenever its identity changes, and per-render reattachment
 * used to reset the bottom pin, yanking a reader who had scrolled up back
 * down), the scroll listener, the viewport ResizeObserver and the scroller's
 * tab stop. The handlers may change every render; the latest are used.
 */
export function useScrollerBinding({ rows, onScroll, onResize }: Options) {
  const scroller = useRef<HTMLElement | null>(null);
  const resize = useRef<ResizeObserver | null>(null);
  const handlers = useRef({ onScroll, onResize });
  useEffect(() => {
    handlers.current = { onScroll, onResize };
  });
  const scrollListener = useCallback(() => {
    handlers.current.onScroll();
  }, []);

  const scrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      const node = el instanceof HTMLElement ? el : null;
      if (scroller.current === node) return;
      scroller.current?.removeEventListener('scroll', scrollListener);
      resize.current?.disconnect();
      resize.current = null;
      scroller.current = node;
      if (!node) return;
      node.tabIndex = rows.activeMounted ? -1 : 0;
      // Stable hook for keyboard layers ("focus is on the message list").
      node.setAttribute('data-message-scroller', '');
      node.addEventListener('scroll', scrollListener, { passive: true });
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
    [scrollListener, rows],
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
      resize.current?.disconnect();
    },
    [scrollListener],
  );

  /** Where the scroller stands now (undefined until it mounts). */
  const scrollTopNow = useCallback(() => scroller.current?.scrollTop, []);

  return { scroller, scrollerRef, scrollTopNow };
}
