import { POLL_EMOJI, pollPreviewText } from './poll';
import { bodyToPlainText } from './segments';
import type { Message } from './types';

export type SummarySource = Pick<Message, 'body' | 'ranges' | 'attachments' | 'sticker' | 'poll'>;

export interface SummaryOptions {
  /** Prefix a poll with its icon (lists and notifications); a screen reader skips it. Default true. */
  icon?: boolean;
}

/** "Photo", "3 photos", "Video", "Voice message" or the file's name, for an attachment-only message. */
function attachmentLabel(message: SummarySource): string | null {
  const [first] = message.attachments;
  if (!first) return null;
  const n = message.attachments.length;
  if (first.contentType.startsWith('image/')) return n > 1 ? `${n} photos` : 'Photo';
  if (first.contentType.startsWith('video/')) return 'Video';
  if (first.contentType.startsWith('audio/')) return 'Voice message';
  return first.fileName ?? 'File';
}

/**
 * What a message says in one line, wherever it's shown outside the message
 * itself: the chat list, notifications, the screen-reader announcement.
 * Mentions are resolved and spoilers masked; without text, a poll, sticker
 * or attachment speaks for it. Empty when there is nothing at all, so each
 * surface picks its own fallback.
 */
export function messageSummary(
  message: SummarySource,
  nameFor: (contactId: string) => string,
  options: SummaryOptions = {},
): string {
  const text = bodyToPlainText(message.body, message.ranges, nameFor, { hideSpoilers: true })
    .replace(/\s+/gu, ' ')
    .trim();
  if (text) return text;
  if (message.poll) {
    const question = pollPreviewText(message.poll);
    return options.icon === false ? question : `${POLL_EMOJI} ${question}`;
  }
  if (message.sticker) {
    return message.sticker.emoji ? `${message.sticker.emoji} Sticker` : 'Sticker';
  }
  return attachmentLabel(message) ?? '';
}
