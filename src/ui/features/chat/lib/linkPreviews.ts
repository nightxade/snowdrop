/**
 * Pure helpers for rendering a sender-generated link preview (Signal's
 * `DataMessage.preview`) as an embed card. Recipients never fetch anything
 * here — everything comes from what the sender's client already attached.
 */
import type { Attachment, LinkPreview } from '@/core/domain';
import { URL_PATTERN } from '../message/MessageBody';

/**
 * Signal's own rule (confirmed by signal-cli's `--preview-url` help text:
 * "the same url must also appear in the message body"): a preview is only
 * shown when its exact url is still present among the message's linkified
 * URLs. Guards against a stale preview surviving a later edit that removed
 * the link, and against a non-http(s) url ever reaching an `<a href>`.
 */
export function previewUrlInText(preview: LinkPreview, body: string): boolean {
  if (!/^https?:\/\//iu.test(preview.url)) return false;
  for (const match of body.matchAll(URL_PATTERN)) {
    if (match[0] === preview.url) return true;
  }
  return false;
}

/**
 * The first http(s) URL in the composer's draft text, or undefined — the
 * one Snowdrop will fetch a preview for (one per message, like Signal).
 */
export function firstUrlInText(text: string): string | undefined {
  return text.match(URL_PATTERN)?.[0];
}

/** "example.com" from "https://www.example.com/path" — the card's eyebrow label. */
export function previewDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./iu, '');
  } catch {
    return url;
  }
}

/**
 * Wide images (article banners, 16:9 thumbnails) are shown large, below the
 * text; anything else — square, portrait, or no known size — is a small
 * thumbnail beside it, Discord-style.
 */
export function isWidePreviewImage(
  image: Pick<Attachment, 'width' | 'height'> | undefined,
): boolean {
  if (!image?.width || !image.height) return false;
  return image.width / image.height >= 1.6;
}
