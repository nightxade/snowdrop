import { ignored } from '@/core/lib';
import { useEffect, useState } from 'react';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { useAttachmentUrl } from './useAttachmentUrl';

/**
 * What the full-screen viewer shows for an attachment. Like `useAttachmentUrl`,
 * but for your own sent images the full-quality original kept in the local
 * message store (`Attachment.original`) replaces the preview once it is read:
 * the preview shows meanwhile, and again if the original can't be shown. The
 * original is an object URL held only while `active` (the viewer open on this
 * attachment), so paging through images never holds more than one at a time.
 */
export function useViewerAttachment(
  conversationId: ConversationId,
  message: MessageRef,
  attachment: Attachment,
  attachmentIds: readonly string[],
  active: boolean,
): ReturnType<typeof useAttachmentUrl> {
  const state = useAttachmentUrl(conversationId, message, attachment, attachmentIds);
  const { repository } = useSnowdrop();
  const wanted = active && attachment.original === true;
  const id = attachment.id;
  const contentType = attachment.contentType;
  const [original, setOriginal] = useState<{ id: string; url: string } | null>(null);
  const [broken, setBroken] = useState<string | null>(null);

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    let url: string | undefined;
    repository
      .readSentMedia(id, contentType)
      .then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setOriginal({ id, url });
      })
      .catch(ignored('the preview stays'));
    return () => {
      cancelled = true;
      if (url !== undefined) URL.revokeObjectURL(url);
      setOriginal(null);
    };
  }, [wanted, id, contentType, repository]);

  if (wanted && original?.id === id && broken !== id) {
    return {
      ...state,
      status: 'ready',
      url: original.url,
      onMediaError: () => {
        setBroken(id);
      },
    };
  }
  return state;
}
