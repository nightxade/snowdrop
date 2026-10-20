import { Sticker as StickerIcon } from 'lucide-react';
import { useState } from 'react';
import type { ConversationId, StickerContent } from '@/core/domain';
import { useStickerUrl } from './useStickerUrl';
import styles from './StickerBubble.module.css';

export interface StickerBubbleProps {
  conversationId: ConversationId;
  sticker: StickerContent;
}

/**
 * A sticker, rendered the way Signal/Discord-style clients do: the image
 * alone — no bubble, no card, transparent background — capped at 120px
 * (CSS `max-width`/`max-height`, so it scales correctly on HiDPI displays
 * rather than being pre-downscaled), keeping its own aspect ratio. Animated
 * WebP/APNG animate natively through `<img>`; there's no cheap way to pause
 * that (unlike a CSS animation, a browser gives no hook into it), so
 * `prefers-reduced-motion` is left alone here rather than faking a pause.
 *
 * Loading reserves a fixed box so the message list doesn't jump while the
 * real size is still unknown; a failure (or no way to fetch it at all)
 * shows the emoji — or "Sticker" — in a small muted chip instead of a
 * broken image.
 */
export function StickerBubble({ conversationId, sticker }: StickerBubbleProps) {
  const state = useStickerUrl(conversationId, sticker);
  const [mediaFailed, setMediaFailed] = useState(false);
  const alt = sticker.emoji ? `${sticker.emoji} sticker` : 'Sticker';

  if (state.status === 'error' || state.status === 'unavailable' || mediaFailed) {
    return (
      <div className={styles.fallback} data-snowdrop="sticker">
        {sticker.emoji ? (
          <span aria-hidden>{sticker.emoji}</span>
        ) : (
          <StickerIcon size={14} aria-hidden />
        )}
        <span>Sticker</span>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className={styles.placeholder} data-snowdrop="sticker" aria-label={alt}>
        <StickerIcon size={28} strokeWidth={1.25} aria-hidden />
      </div>
    );
  }

  return (
    <img
      className={styles.image}
      data-snowdrop="sticker"
      src={state.url}
      alt={alt}
      draggable={false}
      decoding="async"
      onError={() => {
        setMediaFailed(true);
      }}
    />
  );
}
