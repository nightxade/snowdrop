/**
 * Data message → domain `Message` (the visible content of one envelope).
 *
 * Content Hearth can't render natively (stickers, view-once media, payments,
 * shared contacts, polls) is shown as an honest italic note rather than
 * dropped silently, so the conversation never has invisible gaps.
 */
import {
  messageId,
  type Attachment,
  type BodyRange,
  type ConversationId,
  type Message,
  type MessageStatus,
  type Quote,
} from '@/core/domain';
import { addressId, type WireAttachment, type WireDataMessage, type WireQuote } from '../wire';
import { sortRanges, toBodyRanges } from './ranges';

export interface MessageMeta {
  conversationId: ConversationId;
  authorId: string;
  receivedAt: number;
  status: MessageStatus;
  /** Maps an address to our canonical id (self aliases → selfId). */
  resolveId: (id: string) => string;
  /** Start of the disappearing timer (server receive time, capped at now). */
  timerStart: number;
}

/** Attachment ids are signal-cli's local file ids; fall back to a stable synthetic id. */
export function toAttachment(a: WireAttachment, fallbackId: string): Attachment {
  const out: Attachment = { id: a.id ?? fallbackId, contentType: a.contentType };
  if (a.filename !== undefined) out.fileName = a.filename;
  if (a.size !== undefined) out.size = a.size;
  if (a.width !== undefined && a.width > 0) out.width = a.width;
  if (a.height !== undefined && a.height > 0) out.height = a.height;
  return out;
}

export function toQuote(q: WireQuote, resolveId: (id: string) => string): Quote | undefined {
  const author = addressId(q.authorUuid, q.authorNumber, q.author);
  if (!author) return undefined;
  let text = q.text ?? '';
  const ranges = toBodyRanges(text, q.textStyles, q.mentions).map((r) =>
    r.mentionId === undefined ? r : { ...r, mentionId: resolveId(r.mentionId) },
  );
  if (!text && q.attachments.length > 0) {
    const first = q.attachments[0];
    text = first?.filename ?? describeContentType(first?.contentType ?? '');
  }
  const quote: Quote = { authorId: resolveId(author), sentAt: q.id, text };
  if (ranges.length > 0) quote.ranges = ranges;
  if (q.attachments.length > 0) {
    quote.attachments = q.attachments.map((a) =>
      a.filename
        ? { contentType: a.contentType, fileName: a.filename }
        : { contentType: a.contentType },
    );
  }
  return quote;
}

function describeContentType(contentType: string): string {
  if (contentType.startsWith('image/')) return 'Photo';
  if (contentType.startsWith('video/')) return 'Video';
  if (contentType.startsWith('audio/')) return 'Audio';
  return 'Attachment';
}

/** Appends an italic note (for unsupported content) to a body. */
function withNote(body: string, ranges: BodyRange[], note: string): [string, BodyRange[]] {
  const prefix = body ? `${body}\n` : '';
  return [
    prefix + note,
    sortRanges([...ranges, { start: prefix.length, length: note.length, style: 'italic' }]),
  ];
}

/** Notes for content kinds we can't show; empty when there's nothing special. */
function unsupportedNotes(data: WireDataMessage): string[] {
  const notes: string[] = [];
  if (data.viewOnce) notes.push('View-once media — open it on your phone.');
  if (data.sticker) notes.push('Sent a sticker.');
  if (data.payment !== undefined) notes.push('Sent a payment — view it on your phone.');
  for (const c of data.contacts) {
    const name =
      c.name?.nickname ??
      ([c.name?.given, c.name?.family].filter(Boolean).join(' ') || c.organization);
    notes.push(name ? `Shared a contact: ${name}` : 'Shared a contact.');
  }
  return notes;
}

/**
 * Builds the visible message, or null when the data message carries nothing
 * to show (profile-key updates, end-session, empty transcripts).
 */
export function buildMessage(data: WireDataMessage, meta: MessageMeta): Message | null {
  let body = data.message ?? '';
  let ranges = toBodyRanges(body, data.textStyles, data.mentions).map((r) =>
    r.mentionId === undefined ? r : { ...r, mentionId: meta.resolveId(r.mentionId) },
  );

  if (data.pollCreate) {
    const { question, options } = data.pollCreate;
    const prefix = body ? `${body}\n` : '';
    const title = `Poll: ${question}`;
    body = `${prefix}${title}${options.map((o) => `\n• ${o}`).join('')}`;
    ranges = sortRanges([...ranges, { start: prefix.length, length: title.length, style: 'bold' }]);
    [body, ranges] = withNote(body, ranges, 'Vote on your phone.');
  }
  for (const note of unsupportedNotes(data)) [body, ranges] = withNote(body, ranges, note);

  // View-once media must not be kept around or shown here.
  const attachments = data.viewOnce
    ? []
    : data.attachments.map((a, i) => toAttachment(a, `${meta.authorId}:${data.timestamp}:${i}`));
  const quote = data.quote ? toQuote(data.quote, meta.resolveId) : undefined;

  if (!body && attachments.length === 0 && !quote) return null;

  const message: Message = {
    id: messageId(meta.authorId, data.timestamp),
    conversationId: meta.conversationId,
    authorId: meta.authorId,
    sentAt: data.timestamp,
    receivedAt: meta.receivedAt,
    body,
    ranges,
    attachments,
    reactions: [],
    status: meta.status,
    kind: 'normal',
  };
  if (quote) message.quote = quote;
  const expires = data.expiresInSeconds ?? 0;
  // Signal starts the timer when the message is read; starting it when the
  // server received it errs on the side of deleting early, never keeping a
  // message longer than intended — and a replayed old message is already due.
  if (expires > 0) message.expiresAt = meta.timerStart + expires * 1000;
  return message;
}

/** A one-line system message (timer changes, group updates, calls). */
export function systemMessage(
  meta: Pick<MessageMeta, 'conversationId' | 'authorId' | 'receivedAt'>,
  sentAt: number,
  text: string,
): Message {
  return {
    id: messageId(meta.authorId, sentAt),
    conversationId: meta.conversationId,
    authorId: meta.authorId,
    sentAt,
    receivedAt: meta.receivedAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'system',
    systemText: text,
  };
}
