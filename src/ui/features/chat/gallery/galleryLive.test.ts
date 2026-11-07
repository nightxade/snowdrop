import { describe, expect, it } from 'vitest';
import { applyDelete, type Message, type MessageId } from '@/core/domain';
import { makeMessage } from '@/core/domain/testing';
import { reconcileGallery, type LiveWindow } from './galleryLive';

const image = (id: string) => ({ id, contentType: 'image/png' });
const photo = (seq: number, id = `p${seq}`): Message =>
  makeMessage({ sentAt: seq, seq, attachments: [image(id)] });
const windowOf = (...messages: Message[]): LiveWindow => ({
  ids: messages.map((m) => m.id),
  byId: Object.fromEntries(messages.map((m) => [m.id, m])),
});
const all = (win: LiveWindow): Set<MessageId> => new Set(win.ids);
const ids = (messages: readonly Message[]) => messages.map((m) => m.seq);

describe('reconcileGallery', () => {
  it('returns the same array when nothing changed', () => {
    const tab = [photo(3), photo(2)];
    const win = windowOf(photo(1), ...tab.toReversed());
    expect(reconcileGallery(tab, 'media', true, win, all(win))).toBe(tab);
  });

  it('drops a message deleted for everyone, or that lost its media', () => {
    const a = photo(2);
    const b = photo(1);
    const win = windowOf(applyDelete(b), a);
    expect(ids(reconcileGallery([a, b], 'media', true, win, all(win)))).toEqual([2]);
    const stripped = { ...a, attachments: [] };
    expect(ids(reconcileGallery([a, b], 'media', true, windowOf(b, stripped), new Set()))).toEqual([
      1,
    ]);
  });

  it('drops a message the window no longer holds when its place is inside the window (removed or expired)', () => {
    const [a, b, c] = [photo(3), photo(2), photo(1)] as [Message, Message, Message];
    const win = windowOf(c, a);
    expect(ids(reconcileGallery([a, b, c], 'media', true, win, all(win)))).toEqual([3, 1]);
  });

  it('drops a message that just left the newest end of a window that reaches the present', () => {
    const [newest, rest] = [photo(5), photo(4)] as [Message, Message];
    const win = { ...windowOf(rest), anchoredToPresent: true, gone: new Set([newest.id]) };
    // Not one it merely never held.
    expect(
      ids(reconcileGallery([newest, rest], 'media', true, { ...win, gone: new Set() }, all(win))),
    ).toEqual([5, 4]);
    expect(ids(reconcileGallery([newest, rest], 'media', true, win, all(win)))).toEqual([4]);
    const detached = {
      ...windowOf(rest),
      anchoredToPresent: false,
      gone: new Set([newest.id]),
    };
    expect(ids(reconcileGallery([newest, rest], 'media', true, detached, all(detached)))).toEqual([
      5, 4,
    ]);
  });

  it('keeps a message older than the window (it was never loaded there)', () => {
    const old = photo(1);
    const win = windowOf(photo(5), photo(6));
    expect(reconcileGallery([old], 'media', true, win, all(win))).toEqual([old]);
  });

  it('adds new media from the window, newest first', () => {
    const a = photo(3);
    const fresh = photo(9);
    const win = windowOf(a, fresh);
    expect(ids(reconcileGallery([a], 'media', false, win, new Set([a.id])))).toEqual([9, 3]);
  });

  it('does not add what is older than the paged part while more is still to come, but does once done', () => {
    const tab = [photo(10)];
    const older = photo(4);
    const win = windowOf(older, tab[0] as Message);
    expect(ids(reconcileGallery(tab, 'media', false, win, new Set([tab[0]!.id])))).toEqual([10]);
    expect(ids(reconcileGallery(tab, 'media', true, win, new Set([tab[0]!.id])))).toEqual([10, 4]);
  });

  it('follows a message whose attachments were replaced', () => {
    const a = photo(2, 'x');
    const updated = { ...a, attachments: [image('y')] };
    const out = reconcileGallery([a], 'media', true, windowOf(photo(1), updated), new Set());
    expect(out[0]).toBe(updated);
  });

  it('works per tab: a link preview is only on the links tab', () => {
    const link = makeMessage({
      sentAt: 4,
      seq: 4,
      previews: [{ url: 'https://example.com/' }],
    });
    const win = windowOf(link);
    expect(ids(reconcileGallery([], 'links', true, win, new Set()))).toEqual([4]);
    expect(ids(reconcileGallery([], 'media', true, win, new Set()))).toEqual([]);
  });

  it('does nothing with an empty window', () => {
    const tab = [photo(1)];
    expect(reconcileGallery(tab, 'media', true, windowOf(), new Set())).toBe(tab);
  });
});
