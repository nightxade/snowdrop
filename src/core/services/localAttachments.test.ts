import { describe, expect, it } from 'vitest';
import type { Attachment } from '@/core/domain';
import { keepOriginals } from './localAttachments';

const file = (contentType: string, size = 4) => ({
  fileName: 'f',
  contentType,
  data: new Blob([new Uint8Array(size)]),
});
const att = (id: string): Attachment => ({ id, contentType: 'x' });

describe('keepOriginals', () => {
  it('marks displayable images and returns their bytes, leaving everything else alone', () => {
    const sent = [file('image/png'), file('image/svg+xml'), file('text/plain'), file('image/jpeg')];
    const out = keepOriginals([att('a'), att('b'), att('c'), att('d')], sent, true);
    expect(out.attachments.map((a) => a.original)).toEqual([true, undefined, undefined, true]);
    expect(out.media.map((m) => m.id)).toEqual(['a', 'd']);
  });

  it('keeps nothing when the transport did not acknowledge, or for an empty file', () => {
    expect(keepOriginals([att('a')], [file('image/png')], false).media).toEqual([]);
    expect(keepOriginals([att('a')], [file('image/png', 0)], true).media).toEqual([]);
  });

  it('is not fooled by a type with parameters or capitals', () => {
    expect(keepOriginals([att('a')], [file('Image/PNG; x=y')], true).media).toHaveLength(1);
  });
});
