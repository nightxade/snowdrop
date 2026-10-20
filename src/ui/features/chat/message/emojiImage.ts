/**
 * Helpers for adding someone else's delivered custom emoji to the viewer's
 * own collection (CustomEmojiCard); nothing here talks to the network.
 */

/** The base64 part of a `data:` URL: what two stored copies of one image share. */
export function imagePayload(dataUrl: string): string {
  return dataUrl.slice(dataUrl.indexOf(',') + 1);
}

const NAME_MAX = 32;

/** `name_2`, `name_3`, … — the first one `taken` doesn't claim, within the 32-character limit. */
export function suggestEmojiName(name: string, taken: (name: string) => boolean): string {
  for (let n = 2; n < 1000; n++) {
    const suffix = `_${n}`;
    const candidate = `${name.slice(0, NAME_MAX - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return '';
}
