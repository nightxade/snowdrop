/**
 * What an attachment is, by an allow-list of content types. Content types are
 * sender-controlled, so anything not listed is a plain file (shown only as a
 * download). Lives in the domain because storage queries (the media gallery)
 * classify attachments too.
 */
import type { Attachment } from './types';

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
