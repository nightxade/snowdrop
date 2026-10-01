/**
 * `:shortcode:` lookup for the composer. Loaded on first use: the emoji
 * data (served from our origin, shared with the picker's cache) plus
 * GitHub-style shortcodes, which is what people type from muscle memory.
 */
import { EMOJIBASE_URL } from '@/ui/primitives';

export interface EmojiEntry {
  emoji: string;
  /** Without colons; the first is the canonical one. */
  shortcodes: string[];
  label: string;
}

interface RawEmoji {
  emoji?: unknown;
  hexcode?: unknown;
  label?: unknown;
  version?: unknown;
  group?: unknown;
}

/** Newer emoji render as tofu on many systems; stay a version behind the dataset. */
const MAX_VERSION = 15;

let cached: Promise<readonly EmojiEntry[]> | null = null;

export function loadEmojiIndex(): Promise<readonly EmojiEntry[]> {
  cached ??= build().catch((error: unknown) => {
    cached = null;
    throw error;
  });
  return cached;
}

/** Tests (and anything that already has data) can skip the network. */
export function primeEmojiIndex(entries: readonly EmojiEntry[]): void {
  cached = Promise.resolve(entries);
}

async function build(): Promise<readonly EmojiEntry[]> {
  const [response, shortcodes] = await Promise.all([
    fetch(`${EMOJIBASE_URL}/en/data.json`),
    import('emojibase-data/en/shortcodes/github.json').then(
      (m) => m.default as Record<string, string | string[]>,
    ),
  ]);
  if (!response.ok) throw new Error(`emoji data: HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) return [];
  const out: EmojiEntry[] = [];
  for (const item of raw as RawEmoji[]) {
    if (typeof item.emoji !== 'string' || typeof item.hexcode !== 'string') continue;
    if (typeof item.group !== 'number') continue;
    if (typeof item.version === 'number' && item.version > MAX_VERSION) continue;
    const codes = shortcodes[item.hexcode];
    if (codes === undefined) continue;
    out.push({
      emoji: item.emoji,
      shortcodes: Array.isArray(codes) ? codes : [codes],
      label: typeof item.label === 'string' ? item.label : '',
    });
  }
  return out;
}

/** Prefix matches first (shortest code first), then substring matches. */
export function searchEmoji(
  index: readonly EmojiEntry[],
  query: string,
  limit = 8,
): { entry: EmojiEntry; code: string }[] {
  const q = query.toLowerCase();
  const prefix: { entry: EmojiEntry; code: string }[] = [];
  const inner: { entry: EmojiEntry; code: string }[] = [];
  for (const entry of index) {
    const starts = entry.shortcodes.find((c) => c.startsWith(q));
    if (starts) prefix.push({ entry, code: starts });
    else {
      const has = entry.shortcodes.find((c) => c.includes(q));
      if (has) inner.push({ entry, code: has });
    }
  }
  prefix.sort((a, b) => a.code.length - b.code.length);
  return [...prefix, ...inner].slice(0, limit);
}
