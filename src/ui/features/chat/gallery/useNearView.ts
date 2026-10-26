import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Whether the element is within `margin` px of the viewport (or its nearest
 * scroller), and goes back to false once it scrolls well away: a gallery of
 * thousands of tiles only keeps what is around the viewport loaded.
 *
 * Without IntersectionObserver (jsdom, very old engines) it reports `true`.
 */
export function useNearView<T extends Element>(margin = 240): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [near, setNear] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    // Real engines report right after observing; until then nothing loads.
    setNear(false);
    const io = new IntersectionObserver(
      (entries) => {
        const last = entries[entries.length - 1];
        if (last) setNear(last.isIntersecting);
      },
      { rootMargin: `${margin}px 0px` },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, [margin]);
  return [ref, near];
}
