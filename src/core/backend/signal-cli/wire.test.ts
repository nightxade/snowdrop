// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { decodeOrThrow } from './validate';
import { wireStickerPacks } from './wire';

const KEY = 'c0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ffeec0ff';

describe('wireStickerPacks', () => {
  it('decodes packs and drops the url that embeds the pack key', () => {
    const packs = decodeOrThrow(wireStickerPacks, [
      {
        packId: 'aa01',
        url: `https://signal.art/addstickers/#pack_id=aa01&pack_key=${KEY}`,
        installed: true,
        title: 'Apples',
        author: 'Someone',
        cover: { id: 1, emoji: '🍎', contentType: 'image/webp' },
        stickers: [{ id: 0, emoji: null, contentType: 'image/webp' }],
      },
    ]);
    expect(packs).toEqual([
      {
        packId: 'aa01',
        installed: true,
        title: 'Apples',
        author: 'Someone',
        cover: { id: 1, emoji: '🍎' },
        stickers: [{ id: 0, emoji: '' }],
      },
    ]);
    expect(JSON.stringify(packs)).not.toContain(KEY);
    expect(Object.keys(packs[0] ?? {})).not.toContain('url');
  });

  it('accepts a pack whose files were never downloaded', () => {
    expect(
      decodeOrThrow(wireStickerPacks, [
        {
          packId: 'aa01',
          url: 'u',
          installed: true,
          title: '',
          author: '',
          cover: null,
          stickers: [],
        },
      ]),
    ).toMatchObject([{ packId: 'aa01', cover: undefined, stickers: [] }]);
  });

  it('skips a malformed pack without losing the rest', () => {
    const packs = decodeOrThrow(wireStickerPacks, [
      { installed: true },
      { packId: 'bb02', installed: true, stickers: [{ id: 3 }, { id: 'x' }] },
    ]);
    expect(packs).toHaveLength(1);
    expect(packs[0]?.stickers).toEqual([{ id: 3, emoji: '' }]);
  });
});
