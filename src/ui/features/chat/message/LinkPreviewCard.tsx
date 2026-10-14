import { Link as LinkIcon } from 'lucide-react';
import type { ConversationId, LinkPreview } from '@/core/domain';
import { fitMedia } from '../lib/attachments';
import { isWidePreviewImage, previewDomain, previewUrlInText } from '../lib/linkPreviews';
import { useAttachmentUrl } from './useAttachmentUrl';
import styles from './LinkPreviewCard.module.css';

export interface LinkPreviewCardProps {
  conversationId: ConversationId;
  preview: LinkPreview;
  /** The message's own body — the card is hidden unless `preview.url` is still in it. */
  body: string;
}

const THUMB_BOX = { width: 80, height: 80 };
const WIDE_BOX = { width: 400, height: 220 };

/**
 * Discord-style embed for a sender-generated link preview. Never fetches
 * anything itself — `preview` is exactly what arrived with the message —
 * and only ever opens `preview.url`, the same way a plain link in the
 * message text does (new tab, no referrer).
 */
export function LinkPreviewCard({ conversationId, preview, body }: LinkPreviewCardProps) {
  if (!previewUrlInText(preview, body)) return null;
  const wide = isWidePreviewImage(preview.image);
  const domain = previewDomain(preview.url);
  return (
    <a
      className={styles.card}
      data-layout={wide ? 'wide' : 'thumb'}
      href={preview.url}
      target="_blank"
      rel="noopener noreferrer nofollow"
    >
      <span className={styles.accent} aria-hidden />
      <span className={styles.body}>
        <span className={styles.domain}>
          <LinkIcon size={12} aria-hidden />
          {domain}
        </span>
        {preview.title && <span className={styles.title}>{preview.title}</span>}
        {preview.description && <span className={styles.description}>{preview.description}</span>}
      </span>
      {preview.image && (
        <PreviewImage conversationId={conversationId} attachment={preview.image} wide={wide} />
      )}
    </a>
  );
}

function PreviewImage({
  conversationId,
  attachment,
  wide,
}: {
  conversationId: ConversationId;
  attachment: NonNullable<LinkPreview['image']>;
  wide: boolean;
}) {
  const state = useAttachmentUrl(conversationId, attachment);
  const box = fitMedia(attachment, wide ? WIDE_BOX : THUMB_BOX);
  const style = { width: box.width, aspectRatio: `${box.width} / ${box.height}` };
  if (state.status !== 'ready') {
    // Reserves the same box while loading/unavailable, so nothing jumps once
    // (or if) it resolves — a failed preview image just leaves a blank box
    // rather than an error state, which would overstate the problem for
    // something this incidental to the message.
    return <span className={styles.image} data-layout={wide ? 'wide' : 'thumb'} style={style} />;
  }
  return (
    <img
      className={styles.image}
      data-layout={wide ? 'wide' : 'thumb'}
      style={style}
      src={state.url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={state.onMediaError}
    />
  );
}
