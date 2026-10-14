/**
 * Attachment bytes ⇄ the daemon.
 *
 * signal-cli downloads attachments to its data dir and exposes them only via
 * the `getAttachment` RPC (base64 in JSON), so there is no URL we could put
 * straight into `<img src>`. We therefore resolve lazily — only when the UI
 * actually shows an attachment — into a `blob:` URL, deduplicate concurrent
 * requests, and keep a small LRU so scrolling back and forth doesn't
 * re-download or leak object URLs.
 */
import type { Attachment, LinkPreview } from '@/core/domain';
import type { OutgoingAttachment, OutgoingLinkPreview } from '../types';
import { SignalCliError } from './errors';
import { toDataUri } from './params';
import type { JsonRpcClient, RpcParams } from './rpc';
import { wireAttachmentData } from './wire';

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  // Chunked: String.fromCharCode(...hugeArray) overflows the call stack.
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Media types we let the browser interpret. The content type of an incoming
 * attachment is chosen by the *sender*; labelling a blob `text/html` or
 * `image/svg+xml` would make it scriptable if it were ever navigated to or
 * framed. Everything else is served as opaque bytes.
 */
const SAFE_MEDIA_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/3gpp',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/ogg',
  'audio/opus',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/amr',
]);

export function safeMediaType(contentType: string): string {
  const type = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return SAFE_MEDIA_TYPES.has(type) ? type : 'application/octet-stream';
}

/** Largest file we send or download through the daemon's JSON API. */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** Longest edge of the preview we keep for our own sent images. */
export const THUMBNAIL_MAX_EDGE = 512;

export interface Thumbnail {
  /** `data:` URL of a small re-encoded preview. */
  url: string;
  /** Dimensions of the *original* image. */
  width: number;
  height: number;
}

export type Thumbnailer = (image: Blob) => Promise<Thumbnail | undefined>;

/**
 * Default thumbnailer: decodes with `createImageBitmap` and re-encodes a
 * ≤512 px WebP (JPEG where WebP encoding is unavailable). Returns undefined
 * where the APIs don't exist (tests, old browsers) — the attachment is then
 * shown as a file card.
 */
export const canvasThumbnailer: Thumbnailer = async (image) => {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') {
    return undefined;
  }
  const bitmap = await createImageBitmap(image);
  try {
    const scale = Math.min(1, THUMBNAIL_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.drawImage(bitmap, 0, 0, w, h);
    let blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
    if (blob.type !== 'image/webp')
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
    const type = blob.type === 'image/webp' ? 'image/webp' : 'image/jpeg';
    const base64 = bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
    return { url: `data:${type};base64,${base64}`, width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
};

export interface EncodedAttachment {
  /** What signal-cli's `attachment` param gets. */
  param: string;
  /** Our local record of the sent file (no daemon id: nothing echoes it back). */
  attachment: Attachment;
}

/**
 * Encodes a picked file for `send`. The local record keeps only a small
 * thumbnail for images (persisted with the message), never the whole file:
 * full `data:` URLs would bloat IndexedDB and memory.
 */
export async function encodeOutgoing(
  file: OutgoingAttachment,
  id: string,
  thumbnailer: Thumbnailer = canvasThumbnailer,
): Promise<EncodedAttachment> {
  if (file.data.size === 0) throw new SignalCliError('user', `"${file.fileName}" is empty.`);
  if (file.data.size > MAX_ATTACHMENT_BYTES) {
    throw new SignalCliError('user', `"${file.fileName}" is larger than 100 MB.`);
  }
  const bytes = new Uint8Array(await file.data.arrayBuffer());
  const param = toDataUri(file.contentType, file.fileName, bytesToBase64(bytes));
  const attachment: Attachment = {
    id,
    contentType: file.contentType || 'application/octet-stream',
    fileName: file.fileName,
    size: bytes.length,
  };
  if (safeMediaType(file.contentType).startsWith('image/')) {
    const thumb = await thumbnailer(file.data).catch(() => undefined);
    if (thumb) {
      attachment.url = thumb.url;
      attachment.width = thumb.width;
      attachment.height = thumb.height;
    }
  }
  return { param, attachment };
}

export interface EncodedPreview {
  /** `{ previewUrl, previewTitle, previewDescription?, previewImage? }` material. */
  param: { url: string; title: string; description?: string; image?: string };
  /** Our local record, for the optimistic message and the sent-message echo. */
  preview: LinkPreview;
}

/** Caps the preview image like any other attachment, well under signal-cli's own limit. */
export const MAX_PREVIEW_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Encodes a composer-fetched preview for `send`/`edit`. The image (when
 * present) rides the same data-URI path as a regular attachment.
 */
export async function encodeOutgoingPreview(
  input: OutgoingLinkPreview,
  id: string,
): Promise<EncodedPreview> {
  const preview: LinkPreview = { url: input.url };
  if (input.title) preview.title = input.title;
  if (input.description) preview.description = input.description;
  const param: EncodedPreview['param'] = { url: input.url, title: input.title || input.url };
  if (input.description) param.description = input.description;

  const image = input.image;
  if (image && image.data.size > 0 && image.data.size <= MAX_PREVIEW_IMAGE_BYTES) {
    const bytes = new Uint8Array(await image.data.arrayBuffer());
    const base64 = bytesToBase64(bytes);
    param.image = toDataUri(image.contentType, 'preview', base64);
    const attachment: Attachment = {
      id,
      contentType: image.contentType || 'application/octet-stream',
      size: bytes.length,
      url: `data:${safeMediaType(image.contentType)};base64,${base64}`,
    };
    if (image.width !== undefined) attachment.width = image.width;
    if (image.height !== undefined) attachment.height = image.height;
    preview.image = attachment;
  }
  return { param, preview };
}

export interface AttachmentResolverOptions {
  rpc: JsonRpcClient;
  /** Object URLs kept alive at once; the oldest are revoked beyond this. */
  maxEntries?: number;
  /** Refuse to pull files larger than this through JSON (base64 inflates by a third). */
  maxBytes?: number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export class AttachmentResolver {
  private readonly cache = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<string>>();
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  /** Bumped by clear() so late downloads from a previous session are discarded. */
  private generation = 0;

  constructor(private readonly options: AttachmentResolverOptions) {
    this.maxEntries = options.maxEntries ?? 200;
    this.maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    this.createObjectUrl = options.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl =
      options.revokeObjectUrl ??
      ((url) => {
        URL.revokeObjectURL(url);
      });
  }

  /**
   * `scope` narrows the lookup (`recipient` or `groupId`), as getAttachment
   * allows. `forceRefresh` bypasses both the success cache and any in-flight
   * de-duplication, so a user-initiated retry can't just hand back the same
   * (possibly corrupt — see `onMediaError`) URL it already has: it always
   * starts a fresh download, revoking a cached URL immediately so nothing
   * else hands it out meanwhile.
   */
  resolve(
    attachment: Attachment,
    scope: RpcParams = {},
    options: { forceRefresh?: boolean } = {},
  ): Promise<string> {
    if (attachment.url) return Promise.resolve(attachment.url);
    if (!options.forceRefresh) {
      const cached = this.cache.get(attachment.id);
      if (cached) {
        // Refresh LRU position.
        this.cache.delete(attachment.id);
        this.cache.set(attachment.id, cached);
        return Promise.resolve(cached);
      }
      const pending = this.inFlight.get(attachment.id);
      if (pending) return pending;
    } else {
      const stale = this.cache.get(attachment.id);
      if (stale) {
        this.cache.delete(attachment.id);
        this.revokeObjectUrl(stale);
      }
    }
    if (attachment.size !== undefined && attachment.size > this.maxBytes) {
      return Promise.reject(
        new SignalCliError(
          'too-large',
          'Attachment is too large to open here; open it on your phone.',
        ),
      );
    }
    const generation = this.generation;
    const promise = this.download(attachment, scope)
      .then((url) => {
        if (generation !== this.generation) {
          this.revokeObjectUrl(url);
          throw new SignalCliError('aborted', 'Disconnected while downloading the attachment');
        }
        this.remember(attachment.id, url);
        return url;
      })
      .finally(() => {
        // clear() may have let a newer request for the same id start meanwhile.
        if (this.inFlight.get(attachment.id) === promise) this.inFlight.delete(attachment.id);
      });
    this.inFlight.set(attachment.id, promise);
    return promise;
  }

  /** Revokes every object URL (on disconnect/dispose). */
  clear(): void {
    this.generation++;
    for (const url of this.cache.values()) this.revokeObjectUrl(url);
    this.cache.clear();
    this.inFlight.clear();
  }

  private async download(attachment: Attachment, scope: RpcParams): Promise<string> {
    const { data } = await this.options.rpc.call(
      'getAttachment',
      { id: attachment.id, ...scope },
      wireAttachmentData,
      // Large files take a while to base64 through JSON.
      { timeoutMs: 120_000 },
    );
    // Never label the bytes with an unvetted, sender-chosen type (XSS).
    const blob = new Blob([base64ToBytes(data)], { type: safeMediaType(attachment.contentType) });
    return this.createObjectUrl(blob);
  }

  private remember(id: string, url: string): void {
    this.cache.set(id, url);
    while (this.cache.size > this.maxEntries) {
      const [oldestId, oldestUrl] = this.cache.entries().next().value ?? [];
      if (oldestId === undefined || oldestUrl === undefined) break;
      this.cache.delete(oldestId);
      this.revokeObjectUrl(oldestUrl);
    }
  }
}
