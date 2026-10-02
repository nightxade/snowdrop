/**
 * How attachments may be shown. Content types are sender-controlled, so we
 * only render media for an allow-list of types and only ever through
 * <img>/<video>/<audio> or a download link — never by navigating to or
 * framing the URL (see ChatBackend.resolveAttachmentUrl).
 */
import type { Attachment } from '@/core/domain';

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file';

const IMAGE = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
]);
const VIDEO = new Set(['video/mp4', 'video/webm', 'video/quicktime']);
const AUDIO = new Set([
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
]);

export function attachmentKind(
  attachment: Pick<Attachment, 'contentType' | 'url'>,
): AttachmentKind {
  const type = attachment.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (IMAGE.has(type)) return 'image';
  // SVG is only shown when it's an inline data: URL (the demo's generated
  // images). Even then it's an <img>, where SVG can't run script.
  if (type === 'image/svg+xml' && attachment.url?.startsWith('data:image/svg+xml')) return 'image';
  if (VIDEO.has(type)) return 'video';
  if (AUDIO.has(type)) return 'audio';
  return 'file';
}

/** Media go in the grid; audio and everything else become cards. */
export function isGridMedia(attachment: Pick<Attachment, 'contentType' | 'url'>): boolean {
  const kind = attachmentKind(attachment);
  return kind === 'image' || kind === 'video';
}

export interface MediaBox {
  width: number;
  height: number;
}

/**
 * Size a lone image is shown at: its own aspect ratio, fitted into
 * `max`, never upscaled. Known before the image loads, so nothing shifts.
 */
export function fitMedia(
  attachment: Pick<Attachment, 'width' | 'height'>,
  max: MediaBox = { width: 400, height: 320 },
): MediaBox {
  const w = attachment.width ?? 0;
  const h = attachment.height ?? 0;
  if (w <= 0 || h <= 0)
    return { width: Math.min(max.width, 320), height: Math.min(max.height, 240) };
  const scale = Math.min(1, max.width / w, max.height / h);
  return {
    width: Math.max(48, Math.round(w * scale)),
    height: Math.max(48, Math.round(h * scale)),
  };
}

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? 'GB'}`;
}

/** "Photo", "Video", "Voice message"… for quotes and previews of attachment-only messages. */
export function describeAttachment(a: {
  contentType: string;
  fileName?: string | undefined;
}): string {
  const kind = attachmentKind({ contentType: a.contentType, url: 'data:image/svg+xml' });
  if (kind === 'image') return a.contentType.includes('gif') ? 'GIF' : 'Photo';
  if (kind === 'video') return 'Video';
  if (kind === 'audio') return 'Audio';
  return a.fileName ?? 'File';
}

const SAFE_DATA =
  /^data:(?:image|video|audio)\/[\w.+-]+[;,]|^data:(?:text\/plain|application\/octet-stream)[;,]/iu;

/**
 * An attachment URL is only ever used as a download link if its scheme is
 * one we produce ourselves: `blob:` (local bytes), `data:` with an inert
 * media/plain/binary type, or a same-origin http(s) URL. Anything else
 * (javascript:, data:text/html, other origins) gets no link at all.
 */
export function safeHref(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  if (url.startsWith('blob:')) return url;
  if (url.startsWith('data:')) return SAFE_DATA.test(url) ? url : undefined;
  try {
    const parsed = new URL(url, window.location.href);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      parsed.origin === window.location.origin
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}
