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
  /**
   * False for a pack the demo user has not installed: it appears only when
   * someone sends one of its stickers, and the pack dialog can install it.
   */
  installed: boolean;
}

export const MOCK_STICKER_PACKS: readonly MockStickerPack[] = [
  {
    packId: '9acc9e8aba563d26a4994cd51d4ef8cc',
    title: 'Everyday Moods',
    author: 'Snowdrop Demo',
    installed: true,
    emoji: ['😀', '😂', '🥹', '😍', '🤔', '😴', '🙌', '😅', '😎', '🤯', '😭', '🥳'],
  },
  {
    packId: 'e61fa0867031597467ccc036cc65d403',
    title: 'Critters',
    author: 'Snowdrop Demo',
    installed: true,
    emoji: ['🐱', '🐶', '🦊', '🐸', '🐙', '🦉', '🐧', '🦄'],
  },
  {
    packId: '7e01b6b2fbb3a2b40ccc09c0a1dbd1ee',
    title: 'Snack Break',
    author: 'Snowdrop Demo',
    installed: true,
    emoji: ['🍕', '🍩', '☕', '🍜', '🍓', '🥐'],
  },
  {
    packId: '3c0ffee5ab1e4d2790a8d1f06b7c4e19',
    title: 'Winter Folk',
    author: 'Frostline Studio',
    installed: false,
    emoji: ['⛄', '🧣', '🧤', '🎿', '🦌', '🍵', '🔥', '🌨️', '🛷', '🧦'],
  },
];

/** The pack and sticker id for an emoji, across every demo pack (first match). */
export function mockStickerFor(emoji: string): { packId: string; stickerId: number } | undefined {
  for (const pack of MOCK_STICKER_PACKS) {
    const stickerId = pack.emoji.indexOf(emoji);
    if (stickerId >= 0) return { packId: pack.packId, stickerId };
  }
  return undefined;
}
