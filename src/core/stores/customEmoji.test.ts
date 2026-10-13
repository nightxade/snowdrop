import { describe, expect, it } from 'vitest';
import { createLocalStore, localSchema, selectLocalData } from './local';
import {
  expandTextEmoticons,
  extractCustomEmojiNames,
  parseCustomEmoji,
  parseEmoticonText,
  type CustomEmoji,
} from './customEmoji';

const emoji = { kind: 'image' as const, name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' };
const shrug = { kind: 'text' as const, name: 'shrug', text: '¯\\_(ツ)_/¯' };

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

  it('persists, lists and removes a text emoticon alongside image emoji', () => {
    const store = createLocalStore();
    store.getState().saveCustomEmoji(emoji);
    store.getState().saveCustomEmoji(shrug);
    const restored = localSchema.parse(selectLocalData(store.getState()))!;
    expect(restored.customEmoji).toEqual([emoji, shrug]);
    store.getState().removeCustomEmoji('wave');
    expect(store.getState().customEmoji).toEqual([shrug]);
  });

  it('replaces an entry in place by name, even across kinds', () => {
    const store = createLocalStore();
    store.getState().saveCustomEmoji(shrug);
    store.getState().saveCustomEmoji({ ...emoji, name: 'shrug' });
    expect(store.getState().customEmoji).toEqual([{ ...emoji, name: 'shrug' }]);
  });

  it('counts both kinds toward the one shared 32-entry cap', () => {
    const store = createLocalStore();
    for (let i = 0; i < 16; i++) store.getState().saveCustomEmoji({ ...emoji, name: `img_${i}` });
    for (let i = 0; i < 16; i++) store.getState().saveCustomEmoji({ ...shrug, name: `txt_${i}` });
    expect(() => {
      store.getState().saveCustomEmoji({ ...shrug, name: 'one_too_many' });
    }).toThrow('collection is full');
    expect(store.getState().customEmoji).toHaveLength(32);
  });
});

describe('parsing older (pre-text-emoticon) stored entries', () => {
  it('treats an entry with no `kind` as an image emoji, so existing collections survive untouched', () => {
    const legacy = { name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' };
    expect(parseCustomEmoji(legacy)).toEqual({ kind: 'image', ...legacy });
  });

  it('migrates a whole legacy library on load', () => {
    const legacy = [
      { name: 'wave', dataUrl: 'data:image/png;base64,aGVsbG8=' },
      { name: 'party', dataUrl: 'data:image/png;base64,aGk=' },
    ];
    const restored = localSchema.parse({ customEmoji: legacy })!;
    expect(restored.customEmoji).toEqual(legacy.map((e) => ({ kind: 'image', ...e })));
  });
});

describe('text emoticon validation', () => {
  it('accepts a short run of text, trimmed', () => {
    expect(parseEmoticonText('  ¯\\_(ツ)_/¯  ')).toBe('¯\\_(ツ)_/¯');
  });

  it('rejects empty, whitespace-only, newline-containing and over-length text', () => {
    expect(parseEmoticonText('')).toBeNull();
    expect(parseEmoticonText('   ')).toBeNull();
    expect(parseEmoticonText('line one\nline two')).toBeNull();
    expect(parseEmoticonText('tab\there')).toBeNull();
    expect(parseEmoticonText('x'.repeat(201))).toBeNull();
    expect(parseEmoticonText('x'.repeat(200))).toBe('x'.repeat(200));
  });

  it('rejects a non-string value', () => {
    expect(parseEmoticonText(42)).toBeNull();
    expect(parseEmoticonText(null)).toBeNull();
  });

  it('is rejected by parseCustomEmoji when the text is invalid', () => {
    expect(parseCustomEmoji({ kind: 'text', name: 'blank', text: '   ' })).toBeNull();
    expect(parseCustomEmoji({ kind: 'text', name: 'blank', text: 'a\nb' })).toBeNull();
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

describe('expandTextEmoticons', () => {
  const library: CustomEmoji[] = [shrug, emoji];

  it('replaces a text emoticon token with its text', () => {
    expect(expandTextEmoticons('well :shrug:', library)).toBe('well ¯\\_(ツ)_/¯');
  });

  it('leaves an image emoji name untouched (delivery, not expansion, handles it)', () => {
    expect(expandTextEmoticons('hi :wave:', library)).toBe('hi :wave:');
  });

  it('leaves an unknown name untouched', () => {
    expect(expandTextEmoticons('hi :nope:', library)).toBe('hi :nope:');
  });

  it('expands a token immediately adjacent to another, and repeats of the same token', () => {
    expect(expandTextEmoticons(':shrug::shrug:', library)).toBe('¯\\_(ツ)_/¯¯\\_(ツ)_/¯');
  });

  it('applies the given escape to the inserted text only, leaving the rest of the message alone', () => {
    const wink = { kind: 'text' as const, name: 'wink', text: '^_^' };
    const escape = (s: string) => s.replace(/_/gu, '\\_');
    expect(expandTextEmoticons('hey :wink: and :wave:', [...library, wink], escape)).toBe(
      'hey ^\\_^ and :wave:',
    );
  });

  it('is a no-op when the library has no text emoticons, or the text has no colon', () => {
    expect(expandTextEmoticons('hi :wave:', [emoji])).toBe('hi :wave:');
    expect(expandTextEmoticons('no tokens here', library)).toBe('no tokens here');
  });
});
