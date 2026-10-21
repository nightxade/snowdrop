import { useCallback, useEffect, useState } from 'react';
import type { ConversationId, StickerContent } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { classifyAttachmentFailure } from '../lib/attachments';
import { useMediaHold } from './useMediaHold';

const log = createLogger('ui');

export type StickerUrlState =
  | { status: 'ready'; url: string }
  | { status: 'loading' }
  /** Someone else's sticker in a message request: not fetched until the user asks (useMediaHold). */
  | { status: 'held' }
  | { status: 'error' }
  /** No URL and the backend can't fetch one (the mock always gives one directly). */
  | { status: 'unavailable' };

/**
 * A renderable URL for a sticker. Shaped like `useAttachmentUrl`, but
 * simpler: there's no backfill (that recovery path is attachment-specific),
 * and the fallback chain is explicit rather than a retry loop —
 * `backend.resolveStickerUrl` (the pack itself, fetched through signal-cli's
 * `getSticker`), then the history archive's own backup copy of the image
 * when there is one (`backend.resolveAttachmentUrl`), then `status: 'error'`
 * so the caller shows the emoji/"Sticker" chip instead.
 *
 * No URL cache lives here, for the same reason as `useAttachmentUrl`: the
 * backend's own resolver already caches (and bounds) both paths.
 */
export function useStickerUrl(
  conversationId: ConversationId,
  sticker: StickerContent,
  /** The sender, for the message-request hold; omitted for the user's own picker. */
  authorId?: string,
): StickerUrlState & { retry: () => void; download: () => void } {
  const { backend } = useSnowdrop();
  const key = `${sticker.packId}\u0000${sticker.stickerId}`;
  const { held, release: download } = useMediaHold(conversationId, authorId, key);
  const backupAttachment = sticker.backupAttachment;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    state: StickerUrlState;
  } | null>(null);
  const direct = sticker.url;
  const canResolve = backend.resolveStickerUrl !== undefined;
  const canResolveBackup =
    backupAttachment !== undefined && backend.resolveAttachmentUrl !== undefined;

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // Claims the sticker's own cached URL for as long as this hook stays
  // mounted (see useAttachmentUrl's identical reasoning for attachments).
  useEffect(() => {
    if (held || direct !== undefined || !backend.retainStickerUrl || !backend.releaseStickerUrl)
      return;
    backend.retainStickerUrl(sticker);
    return () => {
      backend.releaseStickerUrl?.(sticker);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, direct, backend, held]);

  // Same protection for the backup attachment, for whatever stretch it's
  // the one actually shown (the pack fetch failed, or isn't supported).
  useEffect(() => {
    if (held || !backupAttachment || !backend.retainAttachmentUrl || !backend.releaseAttachmentUrl)
      return;
    backend.retainAttachmentUrl(backupAttachment);
    return () => {
      backend.releaseAttachmentUrl?.(backupAttachment);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backupAttachment?.id, backend, held]);

  // Nothing to fetch at all (no backend path exists for either the pack or
  // a backup): `unavailable` is derived below, directly from capabilities,
  // with no effect/state round trip needed.
  useEffect(() => {
    if (held || direct !== undefined || (!canResolve && !canResolveBackup)) return;
    let cancelled = false;
    const resolveBackup = async (): Promise<void> => {
      if (!canResolveBackup || !backend.resolveAttachmentUrl) {
        if (!cancelled) setResult({ key, attempt, state: { status: 'error' } });
        return;
      }
      try {
        const url = await backend.resolveAttachmentUrl(conversationId, backupAttachment, {
          forceRefresh: attempt > 0,
        });
        if (!cancelled) setResult({ key, attempt, state: { status: 'ready', url } });
      } catch (error) {
        if (cancelled) return;
        log.warn('sticker download failed', {
          stage: 'backup-attachment',
          kind: classifyAttachmentFailure(error),
        });
        setResult({ key, attempt, state: { status: 'error' } });
      }
    };
    if (canResolve && backend.resolveStickerUrl) {
      backend
        .resolveStickerUrl(sticker, { forceRefresh: attempt > 0 })
        .then((url) => {
          if (!cancelled) setResult({ key, attempt, state: { status: 'ready', url } });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          log.warn('sticker download failed', {
            stage: 'getSticker',
            kind: classifyAttachmentFailure(error),
          });
          void resolveBackup();
        });
    } else {
      void resolveBackup();
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, direct, canResolve, canResolveBackup, backend, conversationId, held]);

  let state: StickerUrlState;
  if (held) state = { status: 'held' };
  else if (direct !== undefined) state = { status: 'ready', url: direct };
  else if (!canResolve && !canResolveBackup) state = { status: 'unavailable' };
  else if (result?.key === key && result.attempt === attempt) state = result.state;
  else state = { status: 'loading' };
  return { ...state, retry, download };
}
