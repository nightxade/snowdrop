/**
 * Attachments on optimistic sends: the local preview (an object URL from the
 * composer) is shown until the transport returns its own URL, and released
 * once nothing shows it any more.
 */
import type { OutgoingAttachment } from '@/core/backend';
import type { Attachment } from '@/core/domain';

/** The optimistic copy of an outgoing attachment: shows the local preview until the transport has a URL. */
export function localAttachment(a: OutgoingAttachment, id: string): Attachment {
  return {
    id,
    contentType: a.contentType,
    fileName: a.fileName,
    size: a.data.size,
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
