import { useCallback, useEffect, useState } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';

export type AttachmentUrlState =
  | { status: 'ready'; url: string }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** No URL and the transport can't fetch one (e.g. an optimistic upload). */
  | { status: 'unavailable' };

/**
 * A renderable URL for an attachment. Attachments that arrive without one
 * (signal-cli downloads lazily) are resolved through the backend, with
 * loading and error states and a retry. The URL is for <img>/<video>/
 * <audio>/<a download> only — never navigation or frames.
 *
 * No URL cache lives here: the backend's own resolver (signal-cli's
 * `AttachmentResolver`) already caches by attachment id and revokes blob
 * URLs it evicts. A second, UI-level cache with its own lifetime would
 * drift out of step with that one — serving a URL the backend already
 * revoked as "ready", with nothing left to retry. Asking the backend on
 * every mount keeps this in lockstep with it instead: a repeat ask for
 * something still cached there resolves on the same microtask (no visible
 * flicker), and an evicted entry is correctly re-downloaded.
 */
export function useAttachmentUrl(
  conversationId: ConversationId,
  attachment: Attachment,
): AttachmentUrlState & { retry: () => void; onMediaError: () => void } {
  const { backend } = useSnowdrop();
  const key = `${conversationId}\u0000${attachment.id}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    state: AttachmentUrlState;
  } | null>(null);
  // A "ready" URL the media element can't load (e.g. revoked, or a corrupt
  // file): re-resolve once automatically, then settle on an error with a
  // manual retry — never an endless error → retry → error loop.
  const [autoRetried, setAutoRetried] = useState<string | null>(null);
  const [mediaError, setMediaError] = useState<{ key: string; attempt: number } | null>(null);
  const direct = attachment.url;
  const canResolve = backend.resolveAttachmentUrl !== undefined;

  useEffect(() => {
    if (direct !== undefined || !backend.resolveAttachmentUrl) return;
    let cancelled = false;
    backend
      .resolveAttachmentUrl(conversationId, attachment)
      .then((url) => {
        if (!cancelled) setResult({ key, attempt, state: { status: 'ready', url } });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Download failed';
        setResult({ key, attempt, state: { status: 'error', message } });
      });
    return () => {
      cancelled = true;
    };
    // The attachment object may be re-created by unrelated message updates; its id is the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt, direct, backend]);

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  const onMediaError = useCallback(() => {
    if (direct === undefined && canResolve && autoRetried !== key) {
      setAutoRetried(key);
      retry();
    } else {
      setMediaError({ key, attempt });
    }
  }, [direct, canResolve, autoRetried, key, attempt, retry]);

  let state: AttachmentUrlState;
  if (mediaError?.key === key && mediaError.attempt === attempt) {
    state = { status: 'error', message: "Couldn't display this file" };
  } else if (direct !== undefined) state = { status: 'ready', url: direct };
  else if (!canResolve) state = { status: 'unavailable' };
  else if (result?.key === key && result.attempt === attempt) state = result.state;
  else state = { status: 'loading' };
  return { ...state, retry, onMediaError };
}
