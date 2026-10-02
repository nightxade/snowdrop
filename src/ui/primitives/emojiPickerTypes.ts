/**
 * Emojibase data is served from our own origin (see devserver/emojibase.ts):
 * the library's default is a public CDN, which would leak picker usage.
 */
export const EMOJIBASE_URL = `${import.meta.env.BASE_URL}emojibase`;

export interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  /** Focus the search field on mount (default true). */
  autoFocus?: boolean;
  columns?: number;
}
