/**
 * The per-conversation media gallery (Signal Desktop's "All media"): which
 * parts of a message belong on which tab, and how they are grouped by date.
 * Pure, so storage (which finds the messages) and the UI (which shows them)
 * agree on what a tab contains.
 */
import { attachmentKind } from './attachmentKind';
import type { Attachment, LinkPreview, Message } from './types';

/** Media = images and video; Audio includes voice notes; Files = everything else attached. */
export type GalleryKind = 'media' | 'audio' | 'files' | 'links';

export const GALLERY_KINDS: readonly GalleryKind[] = ['media', 'audio', 'files', 'links'];

export type GalleryItem =
  | {
      type: 'attachment';
      /** Stable per message part, for React keys and Lightbox positions. */
      key: string;
      message: Message;
      attachment: Attachment;
    }
  | {
      type: 'link';
      key: string;
      message: Message;
      preview: LinkPreview;
    };

function attachmentMatches(attachment: Attachment, kind: GalleryKind): boolean {
  const k = attachmentKind(attachment);
  switch (kind) {
    case 'media':
      return k === 'image' || k === 'video';
    case 'audio':
      return k === 'audio';
    case 'files':
      return k === 'file';
    default:
      return false;
  }
}

/** Links come only from the previews the sender attached, as in Desktop; only http(s) ones. */
function linkMatches(preview: LinkPreview): boolean {
  return /^https?:\/\//iu.test(preview.url);
}

/** Whether a message has anything to show on the tab. */
export function hasGalleryItems(message: Message, kind: GalleryKind): boolean {
  if (message.deleted || message.kind !== 'normal') return false;
  return kind === 'links'
    ? (message.previews ?? []).some(linkMatches)
    : message.attachments.some((a) => attachmentMatches(a, kind));
}

/** A message's items for the tab, in the order they appear in the message. */
export function galleryItemsOf(message: Message, kind: GalleryKind): GalleryItem[] {
  if (!hasGalleryItems(message, kind)) return [];
  if (kind === 'links') {
    return (message.previews ?? []).filter(linkMatches).map((preview, i) => ({
      type: 'link',
      key: `${message.id}\u0000link\u0000${i}`,
      message,
      preview,
    }));
  }
  return message.attachments
    .filter((a) => attachmentMatches(a, kind))
    .map((attachment) => ({
      type: 'attachment',
      key: `${message.id}\u0000${attachment.id}`,
      message,
      attachment,
    }));
}

export type GallerySectionKind = 'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'yearMonth';

export interface GallerySection {
  /** Unique within a grouping. */
  key: string;
  kind: GallerySectionKind;
  label: string;
  items: GalleryItem[];
}

const STATIC_LABEL: Record<Exclude<GallerySectionKind, 'yearMonth'>, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This Week',
  thisMonth: 'This Month',
};

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Groups items the way Signal Desktop's gallery does, by when the message
 * was received: Today, Yesterday, This Week (the last seven days), This
 * Month, then one section per earlier month, newest first. Items inside a
 * section run newest first. `now` is a parameter so the result is testable.
 */
export function groupGalleryByDate(items: readonly GalleryItem[], now: number): GallerySection[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const weekStart = startOfDay(now - 7 * 86_400_000);
  const monthStart = new Date(now);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);
  const month = monthStart.getTime();

  const sorted = [...items].sort((a, b) => b.message.receivedAt - a.message.receivedAt);
  const statics = new Map<keyof typeof STATIC_LABEL, GalleryItem[]>();
  const months = new Map<number, GalleryItem[]>();
  for (const item of sorted) {
    const at = item.message.receivedAt;
    let bucket: keyof typeof STATIC_LABEL | undefined;
    if (at > today) bucket = 'today';
    else if (at > yesterday) bucket = 'yesterday';
    else if (at > weekStart) bucket = 'thisWeek';
    else if (at > month) bucket = 'thisMonth';
    if (bucket) {
      statics.set(bucket, [...(statics.get(bucket) ?? []), item]);
    } else {
      const d = new Date(at);
      const order = d.getFullYear() * 100 + d.getMonth();
      months.set(order, [...(months.get(order) ?? []), item]);
    }
  }

  const sections: GallerySection[] = [];
  for (const kind of ['today', 'yesterday', 'thisWeek', 'thisMonth'] as const) {
    const bucket = statics.get(kind);
    if (bucket) sections.push({ key: kind, kind, label: STATIC_LABEL[kind], items: bucket });
  }
  const formatter = new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric' });
  for (const order of [...months.keys()].sort((a, b) => b - a)) {
    const bucket = months.get(order) ?? [];
    const first = bucket[0];
    if (!first) continue;
    sections.push({
      key: `month:${order}`,
      kind: 'yearMonth',
      label: formatter.format(new Date(first.message.receivedAt)),
      items: bucket,
    });
  }
  return sections;
}
