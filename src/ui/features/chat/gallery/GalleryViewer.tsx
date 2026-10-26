import type { MessageRef } from '@/core/backend';
import type { ConversationId, GalleryItem } from '@/core/domain';
import type { LightboxItem } from '@/ui/primitives';
import { Lightbox } from '@/ui/primitives/Lightbox';
import { attachmentFailureCopy, attachmentKind, safeHref } from '../lib/attachments';
import { useAttachmentUrl } from '../message/useAttachmentUrl';
import type { ItemMeta } from './useItemMeta';

type AttachmentItem = Extract<GalleryItem, { type: 'attachment' }>;

/**
 * The gallery's Lightbox: ←/→ step through every media item loaded so far,
 * newest first. Only the selected one is fetched, so paging through it
 * downloads one file at a time rather than the whole tab.
 */
export function GalleryViewer({
  conversationId,
  items,
  index,
  open,
  describe,
  onIndexChange,
  onOpenChange,
}: {
  conversationId: ConversationId;
  items: readonly AttachmentItem[];
  index: number;
  open: boolean;
  describe: (item: AttachmentItem) => ItemMeta;
  onIndexChange: (index: number) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const selected = items[Math.min(index, items.length - 1)];
  if (!selected) throw new Error('Gallery viewer index is out of range');
  const ref: MessageRef = { authorId: selected.message.authorId, sentAt: selected.message.sentAt };
  const state = useAttachmentUrl(
    conversationId,
    ref,
    selected.attachment,
    selected.message.attachments.map((a) => a.id),
  );
  const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
  const at = Math.min(index, items.length - 1);
  const lightboxItems: LightboxItem[] = items.map((item, i) => {
    const src = i === at && state.status === 'ready' ? state.url : '';
    return {
      src,
      kind: attachmentKind(item.attachment) === 'video' ? 'video' : 'image',
      alt: item.attachment.fileName ?? 'Attachment',
      fileName: item.attachment.fileName,
      downloadHref: src ? safeHref(src) : undefined,
      width: item.attachment.width,
      height: item.attachment.height,
    };
  });
  const meta = describe(selected);
  return (
    <Lightbox
      items={lightboxItems}
      index={at}
      onIndexChange={onIndexChange}
      open={open}
      onOpenChange={onOpenChange}
      caption={`${meta.author} · ${meta.when}`}
      // A held item (message request) stays unfetched until its owner asks.
      mediaStatus={state.status === 'held' ? 'error' : state.status}
      errorLabel={state.status === 'held' ? 'Not downloaded yet' : failure?.label}
      onMediaError={state.onMediaError}
      onRetry={
        state.status === 'held' ? state.download : failure?.retryable ? state.retry : undefined
      }
    />
  );
}
