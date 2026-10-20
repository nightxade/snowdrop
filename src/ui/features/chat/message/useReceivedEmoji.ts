import { useEffect, useState } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { CUSTOM_EMOJI_MAX_BYTES } from '@/core/stores/customEmoji';
import {
  CustomEmojiImageError,
  readCustomEmojiImage,
  useSnowdrop,
  type CustomEmojiImageProblem,
} from '@/ui/hooks';

const log = createLogger('ui');

export type ReceivedEmojiImage =
  | { status: 'loading' }
  /** Passed the collection's own size, type and dimension checks. */
  | { status: 'ready'; dataUrl: string }
  | { status: 'invalid'; problem: CustomEmojiImageProblem }
  | { status: 'error' };

/**
 * Reads a delivered emoji's image through the backend's attachment path
 * (`readAttachmentBlob`: the same `getAttachment` the inline image used) and
 * runs it through exactly the checks a file picked in Settings → Custom
 * emoji gets (`readCustomEmojiImage`): at most 256 KB, PNG/JPEG/GIF/WebP, at
 * most 1024 × 1024. Nothing is uploaded or sent anywhere.
 */
export function useReceivedEmoji(
  conversationId: ConversationId,
  attachment: Attachment,
  attempt = 0,
): ReceivedEmojiImage {
  const { backend } = useSnowdrop();
  const [result, setResult] = useState<{ key: string; image: ReceivedEmojiImage } | null>(null);
  const key = `${attachment.id}\u0000${attempt}`;

  useEffect(() => {
    let cancelled = false;
    const finish = (image: ReceivedEmojiImage) => {
      if (!cancelled) setResult({ key, image });
    };
    const read = backend.readAttachmentBlob;
    if (!read) {
      finish({ status: 'error' });
      return;
    }
    // The advertised size is checked first, so an oversized file is never downloaded.
    if (attachment.size !== undefined && attachment.size > CUSTOM_EMOJI_MAX_BYTES) {
      finish({ status: 'invalid', problem: 'too-large' });
      return;
    }
    read
      .call(backend, conversationId, attachment, { maxBytes: CUSTOM_EMOJI_MAX_BYTES })
      .then((blob) => readCustomEmojiImage(new File([blob], 'emoji', { type: blob.type })))
      .then(
        (dataUrl) => {
          finish({ status: 'ready', dataUrl });
        },
        (error: unknown) => {
          if (error instanceof CustomEmojiImageError) {
            finish({ status: 'invalid', problem: error.problem });
          } else if ((error as { kind?: unknown } | null)?.kind === 'too-large') {
            finish({ status: 'invalid', problem: 'too-large' });
          } else {
            log.warn('received emoji could not be read', {
              kind: error instanceof Error ? error.name : 'unknown',
            });
            finish({ status: 'error' });
          }
        },
      );
    return () => {
      cancelled = true;
    };
    // The attachment is identified by its id (and the retry counter).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, conversationId, key]);

  return result?.key === key ? result.image : { status: 'loading' };
}
