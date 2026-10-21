/**
 * The composer's own link preview (Settings → Behaviour → "Link previews";
 * desktop only, see AppServices.linkPreviewFetch): debounces the first url
 * in the draft, fetches its preview, and lets the user dismiss it for that
 * url. Mirrors Signal's own composer: at most one preview, fetched only
 * when there's a backend for it, never for the browser build.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { OutgoingLinkPreview } from '@/core/backend';
import { useSnowdrop } from '@/ui/hooks';
import { firstUrlInText } from '../lib/linkPreviews';

const DEBOUNCE_MS = 600;

export interface LinkPreviewView {
  /** The url a card should show for, or undefined to show nothing at all. */
  url: string | undefined;
  loading: boolean;
  /** What `send()` should attach; undefined while loading or when nothing was found. */
  preview: OutgoingLinkPreview | undefined;
  dismiss: () => void;
}

interface Loaded {
  url: string;
  preview: OutgoingLinkPreview | undefined;
}

const NONE: Loaded = { url: '', preview: undefined };

/** Revokes a fetched preview's image object URL, if it has one. */
function revokePreview(preview: OutgoingLinkPreview | undefined): void {
  const url = preview?.image?.previewUrl;
  if (url) URL.revokeObjectURL(url);
}

/**
 * `enabled` is the effective link-preview setting and `app.linkPreviewFetch !== null` —
 * passed in rather than read here so this hook has no opinion on where
 * that setting lives, and tests can drive it directly.
 */
export function useLinkPreview(text: string, enabled: boolean): LinkPreviewView {
  const app = useSnowdrop();
  const fetchPreview = enabled ? app.linkPreviewFetch : null;
  const url = fetchPreview ? firstUrlInText(text) : undefined;

  const [loaded, setLoaded] = useState<Loaded>(NONE);
  const [dismissedUrl, setDismissedUrl] = useState<string | null>(null);
  // Mirrors `loaded` for the debounce effect below, so it can read the
  // latest fetch without re-running every time `loaded` itself changes
  // (only `url`/`fetchPreview` changing should restart the debounce).
  // Kept current from an effect, never written during render.
  const loadedRef = useRef(loaded);
  useEffect(() => {
    loadedRef.current = loaded;
  }, [loaded]);

  useEffect(() => {
    if (!url || !fetchPreview) {
      if (loadedRef.current.url !== '') {
        revokePreview(loadedRef.current.preview);
        setLoaded(NONE);
      }
      return;
    }
    if (loadedRef.current.url === url) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchPreview(url)
        .then((preview) => {
          if (cancelled) return;
          revokePreview(loadedRef.current.preview);
          setLoaded({ url, preview });
        })
        .catch(() => {
          if (!cancelled) setLoaded({ url, preview: undefined });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [url, fetchPreview]);

  // Whatever was fetched is only ever shown for the url that's still in the
  // text — a later edit that removes or changes the url must not leave a
  // stale preview on screen (or, worse, attached to the next send).
  const current = loaded.url === url ? loaded.preview : undefined;
  const loading = url !== undefined && loaded.url !== url;

  // Released on unmount, and whenever a later fetch replaces it in the
  // effect above — never while it's still the one on screen.
  useEffect(
    () => () => {
      revokePreview(loadedRef.current.preview);
    },
    [],
  );

  const dismiss = useCallback(() => {
    if (url) setDismissedUrl(url);
  }, [url]);

  // Nothing to show: no url, dismissed, or (once loaded) nothing was found —
  // Signal's own composer doesn't show an empty "no preview" card either.
  if (!url || url === dismissedUrl || (!loading && current === undefined)) {
    return { url: undefined, loading: false, preview: undefined, dismiss };
  }
  return { url, loading, preview: loading ? undefined : current, dismiss };
}
