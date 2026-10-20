import { Sticker as StickerIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConversationId } from '@/core/domain';
import { useStickerUrl } from './useStickerUrl';
import styles from './StickerThumb.module.css';

/** True once `el` has come near the viewport of `root`; stays true after (the image stays loaded). */
function useNearViewport(
  el: HTMLElement | null,
  root: HTMLElement | null,
  enabled: boolean,
): boolean {
  const [near, setNear] = useState(() => !enabled || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !el || (enabled && !root)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root, rootMargin: '96px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [el, root, near, enabled]);
  return near;
}

/**
 * A sticker image in a fixed-size box: the placeholder never changes size, so
 * nothing jumps when the image arrives. `lazy` cells only start fetching once
 * scrolled near view.
 */
export function StickerThumb({
  conversationId,
  sticker,
  root,
  lazy = false,
}: {
  conversationId: ConversationId;
  sticker: { packId: string; stickerId: number; emoji?: string; url?: string };
  root: HTMLElement | null;
  lazy?: boolean;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const near = useNearViewport(el, root, lazy);
  return (
    <span className={styles.thumb} ref={setEl}>
      {near ? (
        <ThumbImage conversationId={conversationId} sticker={sticker} />
      ) : (
        <StickerIcon className={styles.placeholder} aria-hidden />
      )}
    </span>
  );
}

function ThumbImage({
  conversationId,
  sticker,
}: {
  conversationId: ConversationId;
  sticker: { packId: string; stickerId: number; emoji?: string; url?: string };
}) {
  const [failed, setFailed] = useState(false);
  const state = useStickerUrl(conversationId, {
    packId: sticker.packId,
    stickerId: sticker.stickerId,
    ...(sticker.url !== undefined ? { url: sticker.url } : {}),
  });
  if (state.status === 'ready' && !failed)
    return (
      <img
        className={styles.image}
        src={state.url}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => {
          setFailed(true);
        }}
      />
    );
  if (state.status === 'loading' && !failed)
    return <StickerIcon className={styles.placeholder} aria-hidden />;
  return sticker.emoji ? (
    <span className={styles.fallback} aria-hidden>
      {sticker.emoji}
    </span>
  ) : (
    <StickerIcon className={styles.placeholder} aria-hidden />
  );
}
