import { describe, expect, it, vi } from 'vitest';
import { FeatureStore } from '@/core/backend/features';
import { type ConversationId } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { createStores, localSelectors } from '@/core/stores';
import type { TrackDeps } from './voiceTrack';
import { voiceTrackOf } from './voiceTrack';

const cid = 'conv' as ConversationId;
const voice = (id: string) => ({
  id,
  contentType: 'audio/mpeg',
  fileName: 'voice-note.mp3',
  voiceNote: true,
});

function setup(selfId = 'me') {
  const stores = createStores();
  const a = makeMessage({ sentAt: 1, authorId: 'ana', attachments: [voice('va')] });
  const b = makeMessage({ sentAt: 2, authorId: 'ana', attachments: [voice('vb')] });
  stores.messages.setState({
    windows: {
      [cid]: { ids: [a.id, b.id], byId: { [a.id]: a, [b.id]: b } },
    },
  } as never);
  const resolveAttachmentUrl = vi.fn((_c: ConversationId, att: { id: string }) =>
    Promise.resolve(`blob:${att.id}`),
  );
  const deps = {
    stores,
    backend: {
      kind: 'signal-cli',
      capabilities: new FeatureStore(['attachmentUrls']),
      resolveAttachmentUrl,
    },
    selfId,
  } as unknown as TrackDeps;
  return { stores, a, b, deps, resolveAttachmentUrl };
}

describe('voiceTrackOf', () => {
  it('finds the next voice note from the loaded conversation and resolves its audio itself', async () => {
    const { a, b, deps, resolveAttachmentUrl } = setup();
    const track = voiceTrackOf(deps, cid, a.id, a.authorId, a.sentAt, voice('va'));
    const next = await track.next?.();
    expect(next?.key).toBe(`${b.id}\u0000vb`);
    await expect(next?.resolveUrl()).resolves.toBe('blob:vb');
    expect(resolveAttachmentUrl).toHaveBeenCalledOnce();
    expect(await next?.next?.()).toBeUndefined();
  });

  it("marks someone else's note played when it starts, but not your own", () => {
    const theirs = setup();
    const key = 'ana\u00001';
    const track = voiceTrackOf(theirs.deps, cid, theirs.a.id, 'ana', 1, voice('va'));
    expect(localSelectors.voiceNotePlayed(key)(theirs.stores.local.getState())).toBe(false);
    track.onStart?.();
    expect(localSelectors.voiceNotePlayed(key)(theirs.stores.local.getState())).toBe(true);
    const mine = setup('ana');
    voiceTrackOf(mine.deps, cid, mine.a.id, 'ana', 1, voice('va')).onStart?.();
    expect(localSelectors.voiceNotePlayed(key)(mine.stores.local.getState())).toBe(false);
  });

  it('looks in storage when the playing message has left the window (scrolled far away)', async () => {
    const { a, b, deps, stores } = setup();
    stores.messages.setState({
      windows: { [cid]: { ids: [], byId: {}, anchoredToPresent: true } },
    } as never);
    const repository = {
      get: vi.fn().mockResolvedValue(a),
      page: vi.fn().mockResolvedValue([makeMessage({ sentAt: 5, body: 'text' }), b]),
    };
    Object.assign(deps, { repository });
    const next = await voiceTrackOf(deps, cid, a.id, a.authorId, a.sentAt, voice('va')).next?.();
    expect(next?.key).toBe(`${b.id}\u0000vb`);
    expect(repository.page).toHaveBeenCalledWith(cid, { after: a.seq, limit: 50 });
  });

  it('pages on through storage until it finds one, and gives up at the end', async () => {
    const { a, b, deps, stores } = setup();
    stores.messages.setState({ windows: {} } as never);
    const filler = (n: number) =>
      Array.from({ length: 50 }, (_, i) =>
        makeMessage({ sentAt: 100 + n * 50 + i, seq: 100 + n * 50 + i, body: 'x' }),
      );
    const page = vi.fn().mockResolvedValueOnce(filler(0)).mockResolvedValueOnce([b]);
    Object.assign(deps, { repository: { get: vi.fn().mockResolvedValue(a), page } });
    const found = await voiceTrackOf(deps, cid, a.id, a.authorId, a.sentAt, voice('va')).next?.();
    expect(found?.key).toBe(`${b.id}\u0000vb`);
    expect(page).toHaveBeenCalledTimes(2);
    const none = vi.fn().mockResolvedValue([]);
    Object.assign(deps, { repository: { get: vi.fn().mockResolvedValue(a), page: none } });
    expect(
      await voiceTrackOf(deps, cid, a.id, a.authorId, a.sentAt, voice('va')).next?.(),
    ).toBeUndefined();
  });

  it('does not touch storage for the last note of a window that reaches the present', async () => {
    const { b, deps, stores } = setup();
    const win = stores.messages.getState().windows[cid]!;
    stores.messages.setState({ windows: { [cid]: { ...win, anchoredToPresent: true } } } as never);
    const repository = { get: vi.fn(), page: vi.fn() };
    Object.assign(deps, { repository });
    expect(
      await voiceTrackOf(deps, cid, b.id, b.authorId, b.sentAt, voice('vb')).next?.(),
    ).toBeUndefined();
    expect(repository.get).not.toHaveBeenCalled();
  });

  it('says where the note comes from', () => {
    const { a, deps } = setup();
    expect(voiceTrackOf(deps, cid, a.id, 'ana', a.sentAt, voice('va')).source).toEqual({
      conversationId: cid,
      messageId: a.id,
      authorId: 'ana',
    });
  });

  it('holds the cached audio while it plays', () => {
    const { a, deps } = setup();
    const retainAttachmentUrl = vi.fn();
    const releaseAttachmentUrl = vi.fn();
    Object.assign(deps.backend, { retainAttachmentUrl, releaseAttachmentUrl });
    const release = voiceTrackOf(deps, cid, a.id, 'ana', a.sentAt, voice('va')).retain?.();
    expect(retainAttachmentUrl).toHaveBeenCalledOnce();
    release?.();
    expect(releaseAttachmentUrl).toHaveBeenCalledOnce();
  });
});
