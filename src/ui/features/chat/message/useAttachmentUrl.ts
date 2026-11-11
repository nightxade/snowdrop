import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { MessageRef } from '@/core/backend';
import type { Attachment, ConversationId } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { sessionSelectors } from '@/core/stores';
import { useBackendFeature, useSnowdrop } from '@/ui/hooks';
import { classifyAttachmentFailure, type AttachmentFailureKind } from '../lib/attachments';
import { backfillGate, type BackfillSlot } from './backfillGate';
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
  /** A backfill request is outstanding (patches/signal-cli, "0014"): "Getting it from your phone…". */
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
 * (patches/signal-cli's 0012 recovery path has no pointer, or never did) —
 * is only ever escalated to asking our primary device to re-upload the
 * attachment (`requestAttachmentBackfill`, patch 0014) when the user asks:
 * `fromPhone` is then defined, and calling it sends the request. Nothing is
 * requested on mount or scroll — each request makes the phone re-upload and
 * notify, and a gallery mounts dozens of old, expired tiles at once. Requests
 * are also spread out by `backfillGate` (a handful outstanding at a time).
 * The ask is recorded per message in `stores.local.backfillRequested`. While
 * a request is outstanding this reports `backfilling` instead of `error`;
 * the phone's eventual answer arrives through
 * `stores.session.attachmentBackfills` (written by SyncService from the
 * backend's `attachmentBackfill` event) and either triggers a fresh download
 * attempt (`ready`) or settles into a backfill-specific error (`failed`, or
 * a ~2 minute silence), whose `retry` asks the phone again.
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
   * answers with and fail outright (see patches/signal-cli's "0014"
   * README). Defaults to this attachment alone for callers (link previews,
   * custom emoji) whose attachment isn't part of a sibling list.
   */
  attachmentIds: readonly string[] = [attachment.id],
): AttachmentUrlState & {
  retry: () => void;
  onMediaError: () => void;
  download: () => void;
  /** Defined only when the file is gone locally and the phone could re-send it. */
  fromPhone: (() => void) | undefined;
} {
  const { backend, stores } = useSnowdrop();
  const canBackfill = useBackendFeature('attachmentBackfill');
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
  const [backfillWait, setBackfillWait] = useState<{
    attempt: number;
    timedOut: boolean;
    sendFailed?: boolean;
  } | null>(null);
  const direct = attachment.url;
  const canResolve = useBackendFeature('attachmentUrls');
  const backfill = useStore(
    stores.session,
    sessionSelectors.attachmentBackfill(message.authorId, message.sentAt),
  );

  const retry = useCallback(() => {
    setAttempt((n) => n + 1);
  }, []);

  // The turn this hook instance holds in `backfillGate`, from the click until
  // the request is answered, fails, times out or the component goes away.
  const slot = useRef<BackfillSlot | null>(null);
  const freeSlot = useCallback(() => {
    slot.current?.release();
    slot.current = null;
  }, []);
  useEffect(() => freeSlot, [freeSlot]);

  // The one place a backfill request is sent, and only ever from a click.
  const askPhone = useCallback(() => {
    if (!canBackfill) return;
    freeSlot();
    const mine = backfillGate.acquire();
    slot.current = mine;
    stores.local.getState().markBackfillRequested(backfillKey);
    // A stale answer to an earlier request for this message (e.g. the
    // "failed" that got us here) must not immediately end the new wait.
    stores.session.getState().clearAttachmentBackfill(backfillKey);
    setBackfillWait({ attempt, timedOut: false });
    void mine.granted.then((go) => {
      if (!go) return;
      backend
        .requestAttachmentBackfill(conversationId, message.authorId, message.sentAt, attachmentIds)
        .catch((backfillError: unknown) => {
          log.warn('attachment backfill request failed', {
            kind: classifyAttachmentFailure(backfillError),
          });
          // The request never reached the phone: leave the spinner now, not
          // after the ceiling, and offer Retry (which asks again).
          setBackfillWait((current) =>
            current && current.attempt === attempt ? { ...current, sendFailed: true } : current,
          );
          if (slot.current === mine) freeSlot();
        });
    });
    // The ids are the identity; the arrays/objects are re-created by unrelated updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, canBackfill, freeSlot, stores, backfillKey, attempt, conversationId]);

  // Claims this attachment's cached URL for as long as this hook instance
  // stays mounted, so the backend's own cache (signal-cli's
  // `AttachmentResolver`, bounded by entry count and total bytes) never
  // evicts one still shown on screen — an image, a playing video/audio, or
  // an open lightbox. Keyed on identity alone, not `attempt`: a retry's
  // cleanup-then-rerun must not let the ref count touch zero in between,
  // which could let an unrelated eviction elsewhere revoke the very URL
  // about to be swapped in. Backends without `attachmentUrls` (the mock; its
  // attachments always carry a `url`, so there's nothing to protect) simply
  // skip this.
  useEffect(() => {
    if (held || direct !== undefined || !canResolve) return;
    backend.retainAttachmentUrl(attachment);
    return () => {
      backend.releaseAttachmentUrl(attachment);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, direct, backend, held, canResolve]);

  useEffect(() => {
    if (held || direct !== undefined || !canResolve) return;
    let cancelled = false;
    // Leaving the tile stops waiting for the download (a shared download
    // keeps going and lands in the cache); the abort is not a failure.
    const controller = new AbortController();
    // Every retry (attempt > 0, whether clicked or the one automatic retry
    // after a media error) bypasses the resolver's cache: handing back a URL
    // already known not to work would make the retry a no-op.
    backend
      .resolveAttachmentUrl(conversationId, attachment, {
        forceRefresh: attempt > 0,
        signal: controller.signal,
      })
      .then((url) => {
        if (!cancelled) setResult({ key, attempt, state: { status: 'ready', url } });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const kind = classifyAttachmentFailure(error);
        log.warn('attachment download failed', { kind });
        setResult({ key, attempt, state: { status: 'error', kind } });
        setBackfillWait(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // The attachment/message objects may be re-created by unrelated updates; their ids are the identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, backfillKey, attempt, direct, backend, held, canResolve]);

  // The ~2 minute ceiling on an outstanding backfill request: no answer by
  // then reads the same as an explicit `failed` response.
  useEffect(() => {
    if (!backfillWait || backfillWait.timedOut || backfillWait.sendFailed) return;
    const { attempt: waitingAttempt } = backfillWait;
    const timer = setTimeout(() => {
      setBackfillWait((current) =>
        current && current.attempt === waitingAttempt ? { ...current, timedOut: true } : current,
      );
      freeSlot();
    }, ATTACHMENT_BACKFILL_TIMEOUT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [backfillWait, freeSlot]);

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
      if (
        !currentWait ||
        currentWait.attempt !== currentAttempt ||
        currentWait.timedOut ||
        currentWait.sendFailed
      )
        return;
      const answer = state.attachmentBackfills[backfillKey]?.status;
      if (answer === 'ready' || answer === 'failed') freeSlot();
      if (answer === 'ready') {
        setBackfillWait(null);
        retry();
      }
    });
  }, [backfillKey, stores.session, retry, freeSlot]);

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
  else if (backfillWait?.attempt === attempt && backfillWait.sendFailed) {
    state = { status: 'error', kind: 'backfill-send-failed' };
  } else if (backfillWait?.attempt === attempt && !backfillWait.timedOut) {
    state =
      backfill?.status === 'failed'
        ? { status: 'error', kind: 'backfill-failed' }
        : { status: 'backfilling' };
  } else if (backfillWait?.attempt === attempt && backfillWait.timedOut) {
    state = { status: 'error', kind: 'backfill-timeout' };
  } else if (result?.key === key && result.attempt === attempt) state = result.state;
  else state = { status: 'loading' };
  let fromPhone: (() => void) | undefined;
  let retryAction = retry;
  if (state.status === 'error' && canBackfill) {
    if (state.kind === 'expired' || state.kind === 'missing-on-disk') fromPhone = askPhone;
    // Retrying a phone answer that was "no" or never came asks the phone again.
    else if (
      state.kind === 'backfill-failed' ||
      state.kind === 'backfill-timeout' ||
      state.kind === 'backfill-send-failed'
    )
      retryAction = askPhone;
  }
  return { ...state, retry: retryAction, onMediaError, download, fromPhone };
}
