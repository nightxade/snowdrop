import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { RenderItem } from '@/core/domain';

export type DividerPos = 'above' | 'visible' | 'below';

interface Options {
  items: readonly RenderItem[];
  scroller: RefObject<HTMLElement | null>;
}

/**
 * Where the unread divider is relative to the viewport (rendered rows include
 * overscan). Measuring reads layout, so scroll events only schedule a measure
 * (at most one per animation frame); a range change measures at once.
 */
export function useUnreadDivider({ items, scroller }: Options) {
  const [dividerPos, setDividerPos] = useState<DividerPos>('below');
  const dividerIndex = items.findIndex((it) => it.type === 'new-divider');
  const latestIndex = useRef(dividerIndex);
  const firstRendered = useRef(0);
  const frame = useRef<number | null>(null);
  useLayoutEffect(() => {
    latestIndex.current = dividerIndex;
  });

  const measure = useCallback(() => {
    const el = scroller.current;
    const divider = el?.querySelector('[data-snowdrop="new-divider"]');
    let pos: DividerPos;
    if (el && divider) {
      const view = el.getBoundingClientRect();
      const box = divider.getBoundingClientRect();
      pos = box.bottom < view.top ? 'above' : box.top > view.bottom ? 'below' : 'visible';
    } else {
      const i = latestIndex.current;
      pos = i >= 0 && i < firstRendered.current ? 'above' : 'below';
    }
    setDividerPos(pos);
  }, [scroller]);

  const scheduleMeasure = useCallback(() => {
    if (frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      measure();
    });
  }, [measure]);

  /** `first` is the index of the first rendered row within `items`. */
  const rangeChanged = useCallback(
    (first: number) => {
      firstRendered.current = first;
      measure();
    },
    [measure],
  );

  useEffect(
    () => () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return { dividerIndex, dividerPos, scheduleMeasure, rangeChanged };
}
