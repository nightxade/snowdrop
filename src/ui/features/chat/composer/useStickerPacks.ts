import { useCallback, useEffect, useState } from 'react';
import type { StickerPackInfo } from '@/core/backend';
import { createLogger } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';

const log = createLogger('ui');

export type StickerPacksState =
  | { status: 'loading' }
  | { status: 'ready'; packs: readonly StickerPackInfo[] }
  | { status: 'error' };

/**
 * What the last successful listing returned, per backend: reopening the
 * picker shows it at once while a fresh listing (a cheap local read, which
 * may pick up a pack installed since) runs behind it.
 */
const lastListing = new WeakMap<object, readonly StickerPackInfo[]>();

/**
 * Forgets the cached listing for `backend`, so the next time the picker opens
 * it shows its loading state until a fresh listing lands, instead of the
 * stale one without a pack that was just installed.
 */
export function invalidateStickerPacks(backend: object): void {
  lastListing.delete(backend);
}

/**
 * The user's installed sticker packs, listed each time the picker opens
 * (`enabled`). A failure only surfaces when there is nothing to show yet.
 */
export function useStickerPacks(enabled: boolean): StickerPacksState & { retry: () => void } {
  const { backend } = useSnowdrop();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<StickerPacksState>(() => {
    const cached = lastListing.get(backend);
    return cached ? { status: 'ready', packs: cached } : { status: 'loading' };
  });

  const retry = useCallback(() => {
    setState((current) => (current.status === 'error' ? { status: 'loading' } : current));
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    const list = backend.listStickerPacks;
    if (!enabled || !list) return;
    let cancelled = false;
    list
      .call(backend)
      .then((packs) => {
        lastListing.set(backend, packs);
        if (!cancelled) setState({ status: 'ready', packs });
      })
      .catch((error: unknown) => {
        // The kind only: a failure may carry pack ids in its message.
        log.warn('sticker packs failed', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
        if (!cancelled)
          setState((current) => (current.status === 'ready' ? current : { status: 'error' }));
      });
    return () => {
      cancelled = true;
    };
  }, [backend, enabled, attempt]);

  return { ...state, retry };
}
