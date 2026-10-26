import { describe, expect, it } from 'vitest';
import { galleryItemsOf, groupGalleryByDate, hasGalleryItems } from './gallery';
import { makeMessage } from './testing';
import type { Attachment, GalleryItem, Message } from './index';

const att = (id: string, contentType: string): Attachment => ({ id, contentType });

describe('gallery items', () => {
  const mixed = makeMessage({
    attachments: [
      att('a', 'image/png'),
      att('b', 'application/pdf'),
      att('c', 'video/mp4'),
      att('d', 'audio/ogg'),
    ],
    previews: [{ url: 'https://example.com/x' }, { url: 'ftp://example.com/y' }],
  });

  it('puts each attachment on exactly one tab, in message order', () => {
    const ids = (kind: Parameters<typeof galleryItemsOf>[1]) =>
      galleryItemsOf(mixed, kind).map((i) => (i.type === 'attachment' ? i.attachment.id : 'link'));
    expect(ids('media')).toEqual(['a', 'c']);
    expect(ids('audio')).toEqual(['d']);
    expect(ids('files')).toEqual(['b']);
    expect(ids('links')).toEqual(['link']);
  });

  it('counts voice notes as audio and unknown types as files', () => {
    const m = makeMessage({
      attachments: [{ ...att('v', 'audio/mpeg'), voiceNote: true }, att('x', 'text/html')],
    });
    expect(hasGalleryItems(m, 'audio')).toBe(true);
    expect(hasGalleryItems(m, 'files')).toBe(true);
    expect(hasGalleryItems(m, 'media')).toBe(false);
  });

  it('ignores deleted messages and system lines', () => {
    const attachments = [att('a', 'image/png')];
    expect(hasGalleryItems(makeMessage({ attachments, deleted: true }), 'media')).toBe(false);
    expect(hasGalleryItems(makeMessage({ attachments, kind: 'system' }), 'media')).toBe(false);
  });

  it('gives every item its own key', () => {
    const keys = [...galleryItemsOf(mixed, 'media'), ...galleryItemsOf(mixed, 'links')].map(
      (i) => i.key,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('groupGalleryByDate', () => {
  // Wednesday 14 October 2026, 15:00 local.
  const now = new Date(2026, 9, 14, 15, 0, 0).getTime();
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
  const item = (id: string, receivedAt: number): GalleryItem => {
    const message: Message = makeMessage({ sentAt: receivedAt, receivedAt });
    return { type: 'attachment', key: id, message, attachment: att(id, 'image/png') };
  };
  const labels = (items: GalleryItem[]) => groupGalleryByDate(items, now).map((s) => s.label);

  it('names the recent buckets as Desktop does and leaves empty ones out', () => {
    const sections = groupGalleryByDate(
      [
        item('today', at(2026, 9, 14, 9)),
        item('yesterday', at(2026, 9, 13)),
        item('week', at(2026, 9, 9)),
        item('month', at(2026, 9, 2)),
      ],
      now,
    );
    expect(sections.map((s) => s.label)).toEqual(['Today', 'Yesterday', 'This Week', 'This Month']);
    expect(sections.map((s) => s.items.map((i) => i.key))).toEqual([
      ['today'],
      ['yesterday'],
      ['week'],
      ['month'],
    ]);
    expect(labels([item('only-week', at(2026, 9, 10))])).toEqual(['This Week']);
  });

  it('uses one section per earlier month, newest first', () => {
    expect(
      labels([
        item('a', at(2026, 7, 3)),
        item('b', at(2025, 11, 30)),
        item('c', at(2026, 8, 20)),
        item('d', at(2026, 8, 1)),
      ]),
    ).toEqual(['September 2026', 'August 2026', 'December 2025']);
  });

  it('sorts items newest first inside a section, whatever order they arrive in', () => {
    const [section] = groupGalleryByDate(
      [item('early', at(2026, 9, 14, 8)), item('late', at(2026, 9, 14, 14))],
      now,
    );
    expect(section?.items.map((i) => i.key)).toEqual(['late', 'early']);
  });

  it('keeps the start of today in Today and the instant before it in Yesterday', () => {
    const midnight = new Date(2026, 9, 14, 0, 0, 0).getTime();
    expect(labels([item('a', midnight + 1)])).toEqual(['Today']);
    expect(labels([item('a', midnight - 1)])).toEqual(['Yesterday']);
  });

  it('gives sections distinct keys', () => {
    const sections = groupGalleryByDate(
      [item('a', at(2026, 7, 3)), item('b', at(2026, 6, 3)), item('c', now)],
      now,
    );
    expect(new Set(sections.map((s) => s.key)).size).toBe(sections.length);
  });
});
