import { useCallback, useEffect, useState } from 'react';
import type { StickerPackDetails } from '@/core/backend';
import type { StickerContent } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';

const log = createLogger('ui');

export type StickerPackState =
  { status: 'loading' } | { status: 'ready'; pack: StickerPackDetails } | { status: 'error' };

/**
 * The pack a received sticker belongs to, for the pack dialog (see
 * `ChatBackend.getStickerPack`). Loads once on mount and again on `retry`.
 * A failure logs the error's kind only: its message may name the pack.
 */
export function useStickerPack(sticker: StickerContent): StickerPackState & { retry: () => void } {
  const { backend } = useSnowdrop();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StickerPackState>({ status: 'loading' });
  const { packId, stickerId } = sticker;

  const retry = useCallback(() => {
    setState({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const get = backend.getStickerPack;
    if (!get) return;
    let cancelled = false;
    get
      .call(backend, sticker)
      .then((pack) => {
        if (!cancelled) setState({ status: 'ready', pack });
      })
      .catch((error: unknown) => {
        log.warn('sticker pack failed to load', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // `sticker` is identified by its pack and sticker ids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, packId, stickerId, attempt]);

  // A backend without the capability can only ever fail (the UI doesn't offer it then).
  return { ...(backend.getStickerPack ? state : { status: 'error' as const }), retry };
}
