import { isRecord } from '@/core/persistence';

export interface CustomEmoji {
  name: string;
  dataUrl: string;
}

export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;
const MAX_LIBRARY_CHARS = 1400 * 1024;
export const CUSTOM_EMOJI_NAME = /^[a-z0-9_+-]{1,32}$/u;
const IMAGE_DATA =
  /^data:image\/(png|jpeg|gif|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/u;

export function parseCustomEmoji(value: unknown): CustomEmoji | null {
  if (
    !isRecord(value) ||
    typeof value.name !== 'string' ||
    !CUSTOM_EMOJI_NAME.test(value.name) ||
    typeof value.dataUrl !== 'string' ||
    value.dataUrl.length > (CUSTOM_EMOJI_MAX_BYTES * 4) / 3 + 64
  )
    return null;
  const match = IMAGE_DATA.exec(value.dataUrl);
  if (!match?.[2]) return null;
  return { name: value.name, dataUrl: value.dataUrl };
}

/** Bound the local library so image data cannot exhaust the settings storage. */
export function parseCustomEmojiLibrary(value: unknown): CustomEmoji[] {
  if (!Array.isArray(value)) return [];
  const result: CustomEmoji[] = [];
  const names = new Set<string>();
  let size = 0;
  for (const item of value) {
    const emoji = parseCustomEmoji(item);
    if (!emoji || names.has(emoji.name)) continue;
    if (result.length >= 32 || size + emoji.dataUrl.length > MAX_LIBRARY_CHARS) break;
    size += emoji.dataUrl.length;
    names.add(emoji.name);
    result.push(emoji);
  }
  return result;
}
