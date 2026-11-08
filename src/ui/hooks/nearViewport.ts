/**
 * One IntersectionObserver for every avatar on the page (a list of thousands
 * would otherwise create thousands of them). Each watcher is one-shot: it is
 * told once that its element has come near the viewport, then dropped.
 */
const watchers = new Map<Element, () => void>();
let observer: IntersectionObserver | null = null;

function stop(node: Element): void {
  if (!watchers.delete(node)) return;
  observer?.unobserve(node);
  if (watchers.size === 0) {
    observer?.disconnect();
    observer = null;
  }
}

/** Calls `onNear` once when `node` is within a little of the viewport. Returns the way to stop watching. */
export function whenNearViewport(node: Element, onNear: () => void): () => void {
  observer ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = watchers.get(entry.target);
        if (!callback) continue;
        stop(entry.target);
        callback();
      }
    },
    { rootMargin: '120px' },
  );
  watchers.set(node, onNear);
  observer.observe(node);
  return () => {
    stop(node);
  };
}
