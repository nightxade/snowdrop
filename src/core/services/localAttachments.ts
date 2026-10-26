/**
 * Attachments on optimistic sends: the local preview (an object URL from the
 * composer) is shown until the transport returns its own URL, and released
 * once nothing shows it any more.
 */
import type { OutgoingAttachment, OutgoingLinkPreview } from '@/core/backend';
import type { Attachment, LinkPreview } from '@/core/domain';

/** The optimistic copy of an outgoing attachment: shows the local preview until the transport has a URL. */
export function localAttachment(a: OutgoingAttachment, id: string): Attachment {
  return {
    id,
    contentType: a.contentType,
    fileName: a.fileName,
    size: a.data.size,
    ...(a.voiceNote ? { voiceNote: true } : {}),
    ...(a.previewUrl !== undefined ? { url: a.previewUrl } : {}),
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
  };
}

/**
 * Acknowledged attachments, keeping the local preview URL (and size) for any
 * the transport returned without one — otherwise our own photo would turn
 * into "not available" the moment it's sent. A preview superseded by a real
 * URL is an object URL nobody needs any more, so it is released.
 */
export function withLocalUrls(
  acknowledged: readonly Attachment[] | undefined,
  pending: readonly Attachment[] | undefined,
): Attachment[] {
  if (!acknowledged) return [...(pending ?? [])];
  return acknowledged.map((a, i) => {
    const local = pending?.[i];
    if (!local) return a;
    if (a.url !== undefined) {
      if (local.url?.startsWith('blob:') && local.url !== a.url) revokeLater(local.url);
      return { ...pickSize(local), ...a };
    }
    return { ...pickSize(local), ...a, ...(local.url !== undefined ? { url: local.url } : {}) };
  });
}

/** The optimistic copy of an outgoing link preview: shows the local image preview, if any. */
export function localPreview(p: OutgoingLinkPreview, nonce: string): LinkPreview {
  const preview: LinkPreview = { url: p.url };
  if (p.title) preview.title = p.title;
  if (p.description) preview.description = p.description;
  const image = p.image;
  if (image) {
    preview.image = {
      id: `${nonce}-preview`,
      contentType: image.contentType,
      size: image.data.size,
      ...(image.previewUrl !== undefined ? { url: image.previewUrl } : {}),
      ...(image.width !== undefined ? { width: image.width } : {}),
      ...(image.height !== undefined ? { height: image.height } : {}),
    };
  }
  return preview;
}

/**
 * Merges the sent preview's final image (a stable `data:` URL — see
 * `encodeOutgoingPreview`) with the optimistic one's local object URL,
 * exactly like `withLocalUrls` for regular attachments.
 */
export function finalPreview(
  acknowledged: LinkPreview | undefined,
  pending: LinkPreview | undefined,
): LinkPreview | undefined {
  if (!acknowledged) return pending;
  if (!acknowledged.image) return acknowledged;
  const [image] = withLocalUrls([acknowledged.image], pending?.image ? [pending.image] : []);
  return { ...acknowledged, ...(image ? { image } : {}) };
}

function pickSize(a: Attachment): Partial<Attachment> {
  return {
    ...(a.width !== undefined ? { width: a.width } : {}),
    ...(a.height !== undefined ? { height: a.height } : {}),
  };
}

/** Rows still showing the old URL re-render on the next frame; release it after that. */
function revokeLater(url: string): void {
  if (typeof URL.revokeObjectURL !== 'function') return;
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 5_000);
}
