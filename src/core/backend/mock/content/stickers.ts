/**
 * The demo's installed sticker packs. Each sticker is a generated image (see
 * images.ts's generateStickerUrl) keyed by its emoji, so no asset is bundled.
 */

export interface MockStickerPack {
  /** Hex, like a real pack id. */
  packId: string;
  title: string;
  author: string;
  emoji: readonly string[];
}

export const MOCK_STICKER_PACKS: readonly MockStickerPack[] = [
  {
    packId: '9acc9e8aba563d26a4994cd51d4ef8cc',
    title: 'Everyday Moods',
    author: 'Snowdrop Demo',
    emoji: ['😀', '😂', '🥹', '😍', '🤔', '😴', '🙌', '😅', '😎', '🤯', '😭', '🥳'],
  },
  {
    packId: 'e61fa0867031597467ccc036cc65d403',
    title: 'Critters',
    author: 'Snowdrop Demo',
    emoji: ['🐱', '🐶', '🦊', '🐸', '🐙', '🦉', '🐧', '🦄'],
  },
  {
    packId: '7e01b6b2fbb3a2b40ccc09c0a1dbd1ee',
    title: 'Snack Break',
    author: 'Snowdrop Demo',
    emoji: ['🍕', '🍩', '☕', '🍜', '🍓', '🥐'],
  },
];
