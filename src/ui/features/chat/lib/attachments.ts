/**
 * How attachments may be shown. Content types are sender-controlled, so we
 * only render media for an allow-list of types and only ever through
 * <img>/<video>/<audio> or a download link — never by navigating to or
 * framing the URL (see ChatBackend.resolveAttachmentUrl).
 */
import { attachmentKind, type Attachment, type AttachmentKind } from '@/core/domain';

export { attachmentKind, type AttachmentKind };

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

/**
 * Coarse, display- and log-safe buckets for why an attachment download
 * failed. `rpc-error:<code>` is the fallback for a JSON-RPC error we don't
 * otherwise recognize; `media-decode` isn't a transport failure at all —
 * the bytes downloaded fine but the browser couldn't render them (a corrupt
 * or unsupported file).
 */
export type AttachmentFailureKind =
  | 'missing-on-disk'
  | 'download-failed'
  | 'expired'
  | 'timeout'
  | 'too-large'
  | 'media-decode'
  | `rpc-error:${number}`
  /**
   * `missing-on-disk`/`expired` escalated to asking our primary for a
   * backfill (patches/signal-cli, "0016: attachment backfill"), and the
   * primary answered that it doesn't have the file either (or the request
   * itself failed outright).
   */
  | 'backfill-failed'
  /** Same escalation, but ~2 minutes passed with no answer at all. */
  | 'backfill-timeout';

interface ErrorLike {
  kind?: unknown;
  code?: unknown;
  message?: unknown;
}

function asErrorLike(error: unknown): ErrorLike {
  return typeof error === 'object' && error !== null ? error : {};
}

/**
 * Sorts a failed `resolveAttachmentUrl` rejection into an {@link
 * AttachmentFailureKind}. Reads only `error.kind`/`error.code`/`error.message`
 * duck-typed, rather than importing `SignalCliError` — backend adapters may
 * only be imported from the composition root (eslint boundary rule), and the
 * mock backend's failures (tests) won't be that class anyway. Never returns
 * or logs `message` itself: it can carry the attachment's id.
 */
export function classifyAttachmentFailure(error: unknown): AttachmentFailureKind {
  const { kind, code, message } = asErrorLike(error);
  const k = typeof kind === 'string' ? kind : undefined;
  const text = typeof message === 'string' ? message : '';
  if (k === 'timeout') return 'timeout';
  if (k === 'too-large') return 'too-large';
  if (k === 'user' || k === 'io') {
    if (/no longer available/iu.test(text)) return 'expired';
    if (/could not find attachment/iu.test(text)) return 'missing-on-disk';
    return 'download-failed';
  }
  if (typeof code === 'number') return `rpc-error:${code}`;
  return 'download-failed';
}

export interface AttachmentFailureCopy {
  /** A few words for the tile/card itself. */
  label: string;
  /** A fuller sentence for a tooltip/title. */
  detail: string;
  /** Whether a manual retry stands any realistic chance of helping. */
  retryable: boolean;
}

/** Display copy for {@link AttachmentFailureKind}, reused by every attachment surface. */
export function attachmentFailureCopy(kind: AttachmentFailureKind): AttachmentFailureCopy {
  switch (kind) {
    case 'missing-on-disk':
      return {
        label: 'No longer available',
        detail: "This file isn't on this device and can't be re-downloaded.",
        retryable: false,
      };
    case 'expired':
      return {
        label: 'No longer available',
        detail: 'This file has expired and is no longer on the server.',
        retryable: false,
      };
    case 'too-large':
      return {
        label: "Couldn't open here",
        detail: 'This file is too large to open in Snowdrop. Open it on your phone instead.',
        retryable: false,
      };
    case 'timeout':
      return {
        label: "Couldn't download",
        detail: 'Downloading this file took too long. Try again.',
        retryable: true,
      };
    case 'media-decode':
      return {
        label: "Couldn't display",
        detail: "This file downloaded but couldn't be shown here.",
        retryable: true,
      };
    case 'download-failed':
      return {
        label: "Couldn't download",
        detail: 'Downloading this file failed. Check your connection and try again.',
        retryable: true,
      };
    case 'backfill-failed':
      return {
        label: 'No longer available',
        detail: "Your phone doesn't have this file anymore.",
        retryable: true,
      };
    case 'backfill-timeout':
      return {
        label: 'No longer available',
        detail: "Your phone didn't answer — open Signal on your phone and try again.",
        retryable: true,
      };
    default:
      return {
        label: "Couldn't download",
        detail: 'Something went wrong downloading this file.',
        retryable: true,
      };
  }
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
