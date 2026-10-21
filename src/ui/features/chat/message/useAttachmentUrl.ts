import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { classifyAttachmentFailure, type AttachmentFailureKind } from '../lib/attachments';
import { useMediaHold } from './useMediaHold';

const log = createLogger('ui');

/** No answer from the phone for this long is treated the same as a `failed` response. */
export const ATTACHMENT_BACKFILL_TIMEOUT_MS = 2 * 60_000;

export type AttachmentUrlState =
  | { status: 'ready'; url: string }
  | { status: 'loading' }
  /**
   * Someone else's media in a message request (or blocked chat): nothing is
   * fetched or decoded until the user accepts or asks for this one
   * (`download`). See useMediaHold.
   */
  | { status: 'held' }
  /** A backfill request is outstanding (patches/signal-cli, "0016"): "Getting it from your phone…". */
  | { status: 'backfilling' }
  | { status: 'error'; kind: AttachmentFailureKind }
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
 *
 * A `missing-on-disk`/`expired` failure — nothing local left to retry from
 * (patches/signal-cli's 0014 recovery path has no pointer, or never did) —
 * escalates once, automatically, to asking our primary device to re-upload
 * the attachment (`requestAttachmentBackfill`, patch 0016), when the
 * connected backend supports it. "Once" is tracked per message (not per
 * attachment) in `stores.local.backfillRequested`, so a restart doesn't
 * re-ask for something already pending or already answered; a user-clicked
 * "Try again" always re-asks regardless. While that request is outstanding
 * this reports `backfilling` instead of `error`; the phone's eventual
 * answer arrives through `stores.session.attachmentBackfills` (written by
 * SyncService from the backend's `attachmentBackfill` event) and either
 * triggers a fresh download attempt (`ready`) or settles into a
 * backfill-specific error (`failed`, or a ~2 minute silence).
 *
 * `error.kind` is a coarse, display-safe classification
 * (`src/ui/features/chat/lib/attachments.ts`'s `classifyAttachmentFailure`/
 * `attachmentFailureCopy`) — callers turn it into a label, a tooltip detail,
 * and whether to show Retry at all. Every failure is logged once here, at
 * warn, by that same classification only — never the raw error message,
 * which can carry the attachment's id.
 */
export function useAttachmentUrl(
  conversationId: ConversationId,
  message: MessageRef,
  attachment: Attachment,
  /**
   * The *whole* message's attachment ids, in its own attachment order — not
   * just this one. A backfill response's items aren't individually selected;
   * our primary answers for the entire message, so a request naming fewer
   * ids than it actually has attachments would mismatch the count it
   * answers with and fail outright (see patches/signal-cli's "0016"
   * README). Defaults to this attachment alone for callers (link previews,
   * custom emoji) whose attachment isn't part of a sibling list.
   */
  attachmentIds: readonly string[] = [attachment.id],
): AttachmentUrlState & { retry: () => void; onMediaError: () => void; download: () => void } {
  const { backend, stores } = useSnowdrop();
  const { held, release: download } = useMediaHold(conversationId, message.authorId, attachment.id);
  const key = `${conversationId}\u0000${attachment.id}`;
  const backfillKey = `${message.authorId}\u0000${message.sentAt}`;
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
  // Set while a backfill request made for *this* attempt hasn't yet resolved
  // (via a session event) or timed out. `null` once it has settled one way
  // or the other, or was never asked for this attempt.
  const [backfillWait, setBackfillWait] = useState<{ attempt: number; timedOut: boolean } | null>(
    null,
  );
  const direct = attachment.url;
  const canResolve = backend.resolveAttachmentUrl !== undefined;
  const requestBackfill = backend.requestAttachmentBackfill;
  const canBackfill =
    requestBackfill !== undefined && (backend.supportsAttachmentBackfill?.() ?? false);
  const backfill = useStore(
    stores.session,
    sessionSelectors.attachmentBackfill(message.authorId, message.sentAt),
  );

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // Claims this attachment's cached URL for as long as this hook instance
  // stays mounted, so the backend's own cache (signal-cli's
  // `AttachmentResolver`, bounded by entry count and total bytes) never
  // evicts one still shown on screen — an image, a playing video/audio, or
  // an open lightbox. Keyed on identity alone, not `attempt`: a retry's
  // cleanup-then-rerun must not let the ref count touch zero in between,
  // which could let an unrelated eviction elsewhere revoke the very URL
  // about to be swapped in. Backends without the pair (the mock; its
  // attachments always carry a `url`, so there's nothing to protect) simply
  // skip this.
  useEffect(() => {
    if (
      held ||
      direct !== undefined ||
      !backend.retainAttachmentUrl ||
      !backend.releaseAttachmentUrl
    )
      return;
    backend.retainAttachmentUrl(attachment);
    return () => {
      backend.releaseAttachmentUrl?.(attachment);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, direct, backend, held]);

  useEffect(() => {
    if (held || direct !== undefined || !backend.resolveAttachmentUrl) return;
    let cancelled = false;
    // Every retry (attempt > 0, whether clicked or the one automatic retry
    // after a media error) bypasses the resolver's cache: handing back a URL
    // already known not to work would make the retry a no-op.
    backend
      .resolveAttachmentUrl(conversationId, attachment, { forceRefresh: attempt > 0 })
      .then((url) => {
        if (!cancelled) setResult({ key, attempt, state: { status: 'ready', url } });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind = classifyAttachmentFailure(error);
        log.warn('attachment download failed', { kind });
        setResult({ key, attempt, state: { status: 'error', kind } });
        const recoverable = kind === 'missing-on-disk' || kind === 'expired';
        const alreadyAsked = stores.local.getState().backfillRequested[backfillKey] !== undefined;
        // Auto-request once per message; a manual retry (attempt > 0) always re-asks.
        if (recoverable && requestBackfill && canBackfill && (attempt > 0 || !alreadyAsked)) {
          stores.local.getState().markBackfillRequested(backfillKey);
          // A stale answer to an earlier request for this message (e.g. the
          // "failed" that got us here) must not immediately end the new wait.
          stores.session.getState().clearAttachmentBackfill(backfillKey);
          setBackfillWait({ attempt, timedOut: false });
          requestBackfill(conversationId, message.authorId, message.sentAt, attachmentIds).catch(
            (backfillError: unknown) => {
              log.warn('attachment backfill request failed', {
                kind: classifyAttachmentFailure(backfillError),
              });
            },
          );
        } else {
          setBackfillWait(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // The attachment/message objects may be re-created by unrelated updates; their ids are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backfillKey, attempt, direct, backend, held]);

  // The ~2 minute ceiling on an outstanding backfill request: no answer by
  // then reads the same as an explicit `failed` response.
  useEffect(() => {
    if (!backfillWait || backfillWait.timedOut) return;
    const { attempt: waitingAttempt } = backfillWait;
    const timer = setTimeout(() => {
      setBackfillWait((current) =>
        current && current.attempt === waitingAttempt ? { ...current, timedOut: true } : current,
      );
    }, ATTACHMENT_BACKFILL_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [backfillWait]);

  // The phone answered `ready`: re-download now rather than waiting for the
  // user to notice and click Retry. Subscribed directly (not derived from
  // the `backfill` value above through the dependency array) so the state
  // update lives inside the subscription's own callback, the same as
  // reacting to any other external system — not the effect body itself.
  const latest = useRef({ attempt, backfillWait });
  useEffect(() => {
    latest.current = { attempt, backfillWait };
  });
  useEffect(() => {
    return stores.session.subscribe((state) => {
      const { attempt: currentAttempt, backfillWait: currentWait } = latest.current;
      if (!currentWait || currentWait.attempt !== currentAttempt || currentWait.timedOut) return;
      if (state.attachmentBackfills[backfillKey]?.status === 'ready') {
        setBackfillWait(null);
        retry();
      }
    });
  }, [backfillKey, stores.session, retry]);

  const onMediaError = useCallback(() => {
    if (direct === undefined && canResolve && autoRetried !== key) {
      setAutoRetried(key);
      retry();
    } else {
      // Logged here, once per actual media error event, rather than in the
      // render below (which would re-log every unrelated re-render while
      // this state persists).
      log.warn('attachment download failed', {
        kind: 'media-decode' satisfies AttachmentFailureKind,
      });
      setMediaError({ key, attempt });
    }
  }, [direct, canResolve, autoRetried, key, attempt, retry]);

  let state: AttachmentUrlState;
  if (held) state = { status: 'held' };
  else if (mediaError?.key === key && mediaError.attempt === attempt) {
    state = { status: 'error', kind: 'media-decode' };
  } else if (direct !== undefined) state = { status: 'ready', url: direct };
  else if (!canResolve) state = { status: 'unavailable' };
  else if (backfillWait?.attempt === attempt && !backfillWait.timedOut) {
    state =
      backfill?.status === 'failed'
        ? { status: 'error', kind: 'backfill-failed' }
        : { status: 'backfilling' };
  } else if (backfillWait?.attempt === attempt && backfillWait.timedOut) {
    state = { status: 'error', kind: 'backfill-timeout' };
  } else if (result?.key === key && result.attempt === attempt) state = result.state;
  else state = { status: 'loading' };
  return { ...state, retry, onMediaError, download };
}
