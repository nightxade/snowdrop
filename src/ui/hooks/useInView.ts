import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * Whether the element is currently intersecting the viewport (or its nearest
 * scroller). One observer per call, torn down on unmount.
 *
 * Without IntersectionObserver (jsdom, very old engines) it reports `true`:
 * showing the placeholder's animation is the pre-existing behaviour, and a
 * missing observer must never leave a visible placeholder looking frozen.
 */
export function useInView<T extends Element>(): [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) setInView(last.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
    };
  }, []);
  return [ref, inView];
}
