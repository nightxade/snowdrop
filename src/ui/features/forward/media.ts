/**
 * Getting the bytes of the files being forwarded. Received attachments are
 * fetched lazily, so forwarding must read each one first (a re-send needs the
 * file itself, not a URL). A file that is gone from this device or expired is
 * asked for again from the user's phone, once, the same recovery the message
 * list uses; if that fails too the reason is shown, never an opaque error.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { createLogger } from '@/core/lib';
import type { Stores } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { useSnowdrop } from '@/ui/hooks';
import {
  ATTACHMENT_BACKFILL_TIMEOUT_MS,
  classifyAttachmentFailure,
  type AttachmentFailureKind,
} from '@/ui/features/chat';
import type { ForwardDraft, ForwardFileRef } from './model';

const log = createLogger('ui');

export type MediaLoad =
  | { status: 'loading' }
  /** Asked the phone to upload it again. */
  | { status: 'backfilling' }
  | { status: 'ready'; blob: Blob }
  | { status: 'error'; kind: AttachmentFailureKind };

export type MediaDeps = Pick<AppServices, 'backend' | 'stores'>;

export class MediaError extends Error {
  override name = 'MediaError';
  constructor(readonly kind: AttachmentFailureKind) {
    super(kind);
  }
}

/** How the phone answered a request for a message's files, or that it didn't in time. */
function waitForBackfill(
  stores: Stores,
  key: string,
  timeoutMs: number,
  start: () => Promise<void>,
): Promise<'ready' | 'failed' | 'timeout'> {
  return new Promise((resolve) => {
    let finished = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (outcome: 'ready' | 'failed' | 'timeout') => {
      if (finished) return;
      finished = true;
      unsubscribe();
      clearTimeout(timer);
      resolve(outcome);
    };
    unsubscribe = stores.session.subscribe((state) => {
      const status = state.attachmentBackfills[key]?.status;
      if (status === 'ready' || status === 'failed') finish(status);
    });
    const timer = setTimeout(() => {
      finish('timeout');
    }, timeoutMs);
    start().catch((error: unknown) => {
      log.warn('attachment backfill request failed', { kind: classifyAttachmentFailure(error) });
      finish('failed');
    });
  });
}

/**
 * The bytes of one attachment of a message in `conversationId`. Rejects with a
 * `MediaError` naming why. `onBackfilling` fires when the phone is being asked.
 */
export async function readForwardFile(
  deps: MediaDeps,
  conversationId: ConversationId,
  draft: Pick<ForwardDraft, 'authorId' | 'sentAt' | 'attachmentIds'>,
  file: Pick<ForwardFileRef, 'attachment'>,
  onBackfilling: () => void = () => undefined,
): Promise<Blob> {
  const { backend, stores } = deps;
  const read = async (): Promise<Blob> => {
    if (!backend.readAttachmentBlob) throw new MediaError('download-failed');
    try {
      return await backend.readAttachmentBlob(conversationId, file.attachment);
    } catch (error) {
      const kind = classifyAttachmentFailure(error);
      log.warn('forward attachment read failed', { kind });
      throw new MediaError(kind);
    }
  };
  try {
    return await read();
  } catch (error) {
    const kind = error instanceof MediaError ? error.kind : 'download-failed';
    const recoverable = kind === 'missing-on-disk' || kind === 'expired';
    const canAsk =
      backend.requestAttachmentBackfill !== undefined &&
      (backend.supportsAttachmentBackfill?.() ?? false);
    if (!recoverable || !canAsk) throw error instanceof MediaError ? error : new MediaError(kind);
    const key = `${draft.authorId}\u0000${draft.sentAt}`;
    stores.local.getState().markBackfillRequested(key);
    // A stale answer to an earlier request for this message mustn't end this wait at once.
    stores.session.getState().clearAttachmentBackfill(key);
    onBackfilling();
    const outcome = await waitForBackfill(
      stores,
      key,
      ATTACHMENT_BACKFILL_TIMEOUT_MS,
      () =>
        backend.requestAttachmentBackfill?.(
          conversationId,
          draft.authorId,
          draft.sentAt,
          draft.attachmentIds,
        ) ?? Promise.resolve(),
    );
    if (outcome === 'failed') throw new MediaError('backfill-failed');
    if (outcome === 'timeout') throw new MediaError('backfill-timeout');
    return read();
  }
}

/** The link preview's picture, if it can be read; a preview without one is still a preview. */
export async function readPreviewImage(
  deps: MediaDeps,
  conversationId: ConversationId,
  image: Attachment,
): Promise<Blob | null> {
  try {
    return (await deps.backend.readAttachmentBlob?.(conversationId, image)) ?? null;
  } catch {
    return null;
  }
}

const keyOf = (draft: ForwardDraft, file: ForwardFileRef): string =>
  `${draft.messageId}\u0000${file.key}`;

export interface ForwardMedia {
  /** The state of a file's bytes. */
  stateOf: (draft: ForwardDraft, file: ForwardFileRef) => MediaLoad;
  /** Tries a failed file again (asking the phone again if that was the reason). */
  retry: (draft: ForwardDraft, file: ForwardFileRef) => void;
}

/**
 * Reads every file of `drafts` as the dialog opens, one request each, and
 * keeps their states. A removed file's late result is harmless: nothing reads it.
 */
export function useForwardMedia(
  conversationId: ConversationId,
  drafts: readonly ForwardDraft[],
): ForwardMedia {
  const app = useSnowdrop();
  const [loads, setLoads] = useState<Readonly<Record<string, MediaLoad>>>({});
  const started = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(
    (draft: ForwardDraft, file: ForwardFileRef) => {
      const key = keyOf(draft, file);
      const set = (load: MediaLoad) => {
        if (alive.current) setLoads((current) => ({ ...current, [key]: load }));
      };
      set({ status: 'loading' });
      readForwardFile(app, conversationId, draft, file, () => {
        set({ status: 'backfilling' });
      }).then(
        (blob) => {
          set({ status: 'ready', blob });
        },
        (error: unknown) => {
          set({
            status: 'error',
            kind: error instanceof MediaError ? error.kind : 'download-failed',
          });
        },
      );
    },
    [app, conversationId],
  );

  useEffect(() => {
    for (const draft of drafts)
      for (const file of draft.files) {
        const key = keyOf(draft, file);
        if (started.current.has(key)) continue;
        started.current.add(key);
        run(draft, file);
      }
  }, [drafts, run]);

  return {
    stateOf: (draft, file) => loads[keyOf(draft, file)] ?? { status: 'loading' },
    retry: run,
  };
}
