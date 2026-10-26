import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationId } from '@/core/domain';
import { createStores } from '@/core/stores';
import { readForwardFile, MediaError, type MediaDeps } from './media';

const conversationId = 'dm:mira' as ConversationId;
const draft = { authorId: 'mira', sentAt: 77, attachmentIds: ['a1', 'a2'] };
const file = { attachment: { id: 'a1', contentType: 'image/png' } };
const KEY = 'mira\u0000' + '77';

/** A signal-cli style failure (see classifyAttachmentFailure). */
const gone = () => Object.assign(new Error('Could not find attachment'), { kind: 'user' });
const expired = () => Object.assign(new Error('Attachment no longer available'), { kind: 'user' });

function deps(backend: Record<string, unknown>) {
  const stores = createStores();
  return { backend: backend as unknown as MediaDeps['backend'], stores } satisfies MediaDeps;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('readForwardFile', () => {
  it('reads the bytes through the backend (never a URL)', async () => {
    const blob = new Blob(['x']);
    const readAttachmentBlob = vi.fn().mockResolvedValue(blob);
    const d = deps({ readAttachmentBlob });
    await expect(readForwardFile(d, conversationId, draft, file)).resolves.toBe(blob);
    expect(readAttachmentBlob).toHaveBeenCalledWith(conversationId, file.attachment);
  });

  it('says why a file cannot be read, with no backfill to try', async () => {
    const d = deps({ readAttachmentBlob: vi.fn().mockRejectedValue(expired()) });
    await expect(readForwardFile(d, conversationId, draft, file)).rejects.toMatchObject({
      kind: 'expired',
    });
    const other = deps({
      readAttachmentBlob: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('x'), { kind: 'timeout' })),
    });
    await expect(readForwardFile(other, conversationId, draft, file)).rejects.toMatchObject({
      kind: 'timeout',
    });
    await expect(readForwardFile(deps({}), conversationId, draft, file)).rejects.toBeInstanceOf(
      MediaError,
    );
  });

  it('asks the phone for a file that is gone, waits for the answer, and reads it again', async () => {
    const blob = new Blob(['x']);
    const readAttachmentBlob = vi.fn().mockRejectedValueOnce(gone()).mockResolvedValue(blob);
    const d = deps({
      readAttachmentBlob,
      supportsAttachmentBackfill: () => true,
      requestAttachmentBackfill: vi.fn().mockResolvedValue(undefined),
    });
    const onBackfilling = vi.fn();
    const result = readForwardFile(d, conversationId, draft, file, onBackfilling);
    await vi.advanceTimersByTimeAsync(0);
    expect(onBackfilling).toHaveBeenCalledTimes(1);
    // The whole message's files are named, not just this one.
    expect(d.backend.requestAttachmentBackfill).toHaveBeenCalledWith(conversationId, 'mira', 77, [
      'a1',
      'a2',
    ]);
    expect(d.stores.local.getState().backfillRequested[KEY]).toBeDefined();
    // "pending" is not an answer.
    d.stores.session
      .getState()
      .setAttachmentBackfill(KEY, { status: 'pending', attachmentIds: [] });
    await vi.advanceTimersByTimeAsync(10);
    expect(readAttachmentBlob).toHaveBeenCalledTimes(1);
    d.stores.session
      .getState()
      .setAttachmentBackfill(KEY, { status: 'ready', attachmentIds: ['a1'] });
    await expect(result).resolves.toBe(blob);
    expect(readAttachmentBlob).toHaveBeenCalledTimes(2);
  });

  it('forgets an old answer for the message before asking again', async () => {
    const readAttachmentBlob = vi.fn().mockRejectedValue(gone());
    const d = deps({
      readAttachmentBlob,
      supportsAttachmentBackfill: () => true,
      requestAttachmentBackfill: vi.fn().mockResolvedValue(undefined),
    });
    d.stores.session.getState().setAttachmentBackfill(KEY, { status: 'ready', attachmentIds: [] });
    const result = readForwardFile(d, conversationId, draft, file);
    await vi.advanceTimersByTimeAsync(0);
    expect(d.stores.session.getState().attachmentBackfills[KEY]).toBeUndefined();
    d.stores.session.getState().setAttachmentBackfill(KEY, { status: 'failed', attachmentIds: [] });
    await expect(result).rejects.toMatchObject({ kind: 'backfill-failed' });
  });

  it('gives up when the phone has nothing, or says nothing for two minutes', async () => {
    const make = () =>
      deps({
        readAttachmentBlob: vi.fn().mockRejectedValue(gone()),
        supportsAttachmentBackfill: () => true,
        requestAttachmentBackfill: vi.fn().mockResolvedValue(undefined),
      });
    const failed = make();
    const first = readForwardFile(failed, conversationId, draft, file);
    const firstResult = expect(first).rejects.toMatchObject({ kind: 'backfill-failed' });
    await vi.advanceTimersByTimeAsync(0);
    failed.stores.session
      .getState()
      .setAttachmentBackfill(KEY, { status: 'failed', attachmentIds: [] });
    await firstResult;

    const silent = make();
    const second = readForwardFile(silent, conversationId, draft, file);
    const secondResult = expect(second).rejects.toMatchObject({ kind: 'backfill-timeout' });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await secondResult;
  });

  it('treats a backfill request that itself fails as the phone not having it', async () => {
    const d = deps({
      readAttachmentBlob: vi.fn().mockRejectedValue(gone()),
      supportsAttachmentBackfill: () => true,
      requestAttachmentBackfill: vi.fn().mockRejectedValue(new Error('boom')),
    });
    await expect(readForwardFile(d, conversationId, draft, file)).rejects.toMatchObject({
      kind: 'backfill-failed',
    });
  });

  it('does not ask the phone when the connection cannot', async () => {
    const d = deps({
      readAttachmentBlob: vi.fn().mockRejectedValue(gone()),
      supportsAttachmentBackfill: () => false,
      requestAttachmentBackfill: vi.fn(),
    });
    await expect(readForwardFile(d, conversationId, draft, file)).rejects.toMatchObject({
      kind: 'missing-on-disk',
    });
    expect(d.backend.requestAttachmentBackfill).not.toHaveBeenCalled();
  });
});
