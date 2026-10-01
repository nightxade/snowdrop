import { useCallback, useEffect, useState } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { useHearth } from '@/ui/hooks';

export type AttachmentUrlState =
  | { status: 'ready'; url: string }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  /** No URL and the transport can't fetch one (e.g. an optimistic upload). */
  | { status: 'unavailable' };

/** Resolved URLs outlive rows scrolled out of the virtualised list. */
const resolved = new Map<string, string>();
const MAX_CACHED = 400;

function remember(key: string, url: string): void {
  resolved.set(key, url);
  if (resolved.size > MAX_CACHED) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) resolved.delete(oldest);
  }
}

/**
 * A renderable URL for an attachment. Attachments that arrive without one
 * (signal-cli downloads lazily) are resolved through the backend, with
 * loading and error states and a retry. The URL is for <img>/<video>/
 * <audio>/<a download> only — never navigation or frames.
 */
export function useAttachmentUrl(
  conversationId: ConversationId,
  attachment: Attachment,
): AttachmentUrlState & { retry: () => void } {
  const { backend } = useHearth();
  const key = `${conversationId}\u0000${attachment.id}`;
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{
    key: string;
    attempt: number;
    state: AttachmentUrlState;
  } | null>(null);
  const direct = attachment.url;
  const cached = resolved.get(key);
  const canResolve = backend.resolveAttachmentUrl !== undefined;

  useEffect(() => {
    if (direct !== undefined || resolved.has(key) || !backend.resolveAttachmentUrl) return;
    let cancelled = false;
    backend
      .resolveAttachmentUrl(conversationId, attachment)
      .then((url) => {
        remember(key, url);
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

  let state: AttachmentUrlState;
  if (direct !== undefined) state = { status: 'ready', url: direct };
  else if (cached !== undefined) state = { status: 'ready', url: cached };
  else if (!canResolve) state = { status: 'unavailable' };
  else if (result?.key === key && result.attempt === attempt) state = result.state;
  else state = { status: 'loading' };
  return { ...state, retry };
}
