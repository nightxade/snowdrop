import { describe, expect, it } from 'vitest';
import { createLocalStore, localSchema, selectLocalData } from './local';
import { extractCustomEmojiNames, parseCustomEmoji } from './customEmoji';

const emoji = { name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' };

describe('personal custom emoji', () => {
  it('persists, replaces and removes named emoji', () => {
    const store = createLocalStore();
    store.getState().saveCustomEmoji(emoji);
    store.getState().saveCustomEmoji({ ...emoji, name: 'party' });
    store.getState().saveCustomEmoji(emoji);
    const restored = localSchema.parse(selectLocalData(store.getState()))!;
    expect(restored.customEmoji).toEqual([emoji, { ...emoji, name: 'party' }]);
    store.getState().removeCustomEmoji('wave');
    expect(store.getState().customEmoji.map((e) => e.name)).toEqual(['party']);
    expect(createLocalStore().getState().customEmoji).toEqual([]);
  });

  it('rejects remote URLs, SVG, malformed data and invalid names', () => {
    for (const invalid of [
      { ...emoji, dataUrl: 'https://example.com/image.png' },
      { ...emoji, dataUrl: 'data:image/svg+xml;base64,aGVsbG8=' },
      { ...emoji, dataUrl: 'data:image/png;base64,broken=' },
      { ...emoji, name: '../file' },
    ])
      expect(parseCustomEmoji(invalid)).toBeNull();
  });

  it('bounds the collection and defaults older local data to an empty collection', () => {
    const store = createLocalStore();
    for (let i = 0; i < 32; i++) store.getState().saveCustomEmoji({ ...emoji, name: `emoji_${i}` });
    expect(() => {
      store.getState().saveCustomEmoji(emoji);
    }).toThrow('collection is full');
    expect(store.getState().customEmoji).toHaveLength(32);
    expect(localSchema.parse({ conversations: {} })?.customEmoji).toEqual([]);
  });
});

describe('extractCustomEmojiNames', () => {
  it('finds distinct :name: tokens in first-seen order', () => {
    expect(extractCustomEmojiNames('great :party: and :party: again, :wave:')).toEqual([
      'party',
      'wave',
    ]);
  });

  it('returns nothing for text with no tokens', () => {
    expect(extractCustomEmojiNames('just text, no emoji here')).toEqual([]);
    expect(extractCustomEmojiNames('')).toEqual([]);
  });

  it('ignores a malformed or over-length token', () => {
    expect(extractCustomEmojiNames(`:${'a'.repeat(33)}: :Capital: :has space:`)).toEqual([]);
  });
});
