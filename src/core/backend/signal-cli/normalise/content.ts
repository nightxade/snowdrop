/**
 * Data message → domain `Message` (the visible content of one envelope).
 *
 * Content Snowdrop can't render natively (view-once media, payments, shared
 * contacts) is shown as an honest italic note rather than dropped
 * silently, so the conversation never has invisible gaps. A sticker and a
 * poll *are* rendered natively (see StickerContent/StickerBubble and
 * PollContent/PollCard), so they're handled on their own rather than folded
 * into those notes.
 */
import {
  messageId,
  systemMessageId,
  type Attachment,
  type BodyRange,
  type ConversationId,
  type CustomEmojiDelivery,
  type LinkPreview,
  type Message,
  type MessageStatus,
  type PollContent,
  type Quote,
  type StickerContent,
} from '@/core/domain';
import { graphemes, POLL_LIMITS, stripBidiControls } from '@/core/lib';
import {
  addressId,
  type WireAttachment,
  type WireDataMessage,
  type WirePreview,
  type WireQuote,
} from '../wire';
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
  // Also used as an `<a download>` name, which CSS isolation can't protect.
  if (a.filename !== undefined) out.fileName = stripBidiControls(a.filename);
  if (a.size !== undefined) out.size = a.size;
  if (a.width !== undefined && a.width > 0) out.width = a.width;
  if (a.height !== undefined && a.height > 0) out.height = a.height;
  return out;
}

/**
 * Snowdrop's custom-emoji extension (patches/signal-cli): entries this
 * specific message delivered, each downloadable through the ordinary
 * attachment path. A name without a usable attachment id is dropped rather
 * than rendered with a broken reference.
 */
export function toCustomEmoji(
  data: WireDataMessage,
  fallbackId: (index: number) => string,
): CustomEmojiDelivery[] {
  return data.customEmoji.flatMap((e, i) => {
    if (!e.name) return [];
    return [{ name: e.name, attachment: toAttachment(e.attachment, fallbackId(i)) }];
  });
}

/**
 * Preview image ids are synthetic (signal-cli gives it none of its own
 * beyond the attachment's own `id`, which is already unique); only one
 * preview per message is ever sent, so the index is purely defensive.
 */
export function toLinkPreviews(
  previews: readonly WirePreview[],
  fallbackId: (index: number) => string,
): LinkPreview[] {
  return previews.flatMap((p, i): LinkPreview[] => {
    if (!p.url) return [];
    const preview: LinkPreview = { url: p.url };
    if (p.title) preview.title = stripBidiControls(p.title);
    if (p.description) preview.description = stripBidiControls(p.description);
    if (p.image) preview.image = toAttachment(p.image, fallbackId(i));
    return [preview];
  });
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
    text = first?.filename
      ? stripBidiControls(first.filename)
      : describeContentType(first?.contentType ?? '');
  }
  const quote: Quote = { authorId: resolveId(author), sentAt: q.id, text };
  if (ranges.length > 0) quote.ranges = ranges;
  if (q.attachments.length > 0) {
    quote.attachments = q.attachments.map((a) =>
      a.filename
        ? { contentType: a.contentType, fileName: stripBidiControls(a.filename) }
        : { contentType: a.contentType },
    );
  }
  return quote;
}

/**
 * A sticker this data message carries. The live wire never gives a pack
 * decryption key (`JsonSticker` is just `{packId, stickerId}`) — signal-cli
 * already stores the pack itself on receipt (see docs/SIGNAL_CLI.md), so
 * `getSticker` can retrieve it from just these two.
 */
function toSticker(data: WireDataMessage): StickerContent | undefined {
  return data.sticker
    ? { packId: data.sticker.packId, stickerId: data.sticker.stickerId }
    : undefined;
}

function describeContentType(contentType: string): string {
  if (contentType.startsWith('image/')) return 'Photo';
  if (contentType.startsWith('video/')) return 'Video';
  if (contentType.startsWith('audio/')) return 'Audio';
  return 'Attachment';
}

/** Questions up to this long are accepted from others (Signal Desktop's own receive limit, above what it sends). */
const POLL_QUESTION_RECEIVE_GRAPHEMES = 200;

/**
 * A poll this data message creates, or undefined when it is malformed (no
 * question, fewer than two or more than ten options, an empty or over-long
 * one). Signal Desktop refuses such a poll outright rather than render part
 * of it, so it is never shown as a poll here either.
 */
function toPoll(data: WireDataMessage): PollContent | undefined {
  const create = data.pollCreate;
  if (!create) return undefined;
  const question = stripBidiControls(create.question);
  const options = create.options.map(stripBidiControls);
  if (
    question === '' ||
    graphemes(question).length > POLL_QUESTION_RECEIVE_GRAPHEMES ||
    options.length < POLL_LIMITS.minOptions ||
    options.length > POLL_LIMITS.maxOptions ||
    options.some((o) => o === '' || graphemes(o).length > POLL_LIMITS.optionGraphemes)
  )
    return undefined;
  return { question, options, allowMultiple: create.allowMultiple === true, votes: [] };
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
  if (data.payment !== undefined) notes.push('Sent a payment — view it on your phone.');
  for (const c of data.contacts) {
    const name =
      c.name?.nickname ??
      ([c.name?.given, c.name?.family].filter(Boolean).join(' ') || c.organization);
    notes.push(name ? `Shared a contact: ${stripBidiControls(name)}` : 'Shared a contact.');
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

  const poll = data.pollCreate ? toPoll(data) : undefined;
  if (data.pollCreate && !poll)
    [body, ranges] = withNote(body, ranges, "This poll can't be shown.");
  for (const note of unsupportedNotes(data)) [body, ranges] = withNote(body, ranges, note);

  // View-once media must not be kept around or shown here.
  const attachments = data.viewOnce
    ? []
    : data.attachments.map((a, i) => toAttachment(a, `${meta.authorId}:${data.timestamp}:${i}`));
  const quote = data.quote ? toQuote(data.quote, meta.resolveId) : undefined;
  const customEmoji = data.viewOnce
    ? []
    : toCustomEmoji(data, (i) => `${meta.authorId}:${data.timestamp}:emoji:${i}`);
  const previews = data.viewOnce
    ? []
    : toLinkPreviews(data.previews, (i) => `${meta.authorId}:${data.timestamp}:preview:${i}`);
  const sticker = data.viewOnce ? undefined : toSticker(data);

  if (!body && attachments.length === 0 && !quote && !sticker && !poll) return null;

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
  if (customEmoji.length > 0) message.customEmoji = customEmoji;
  if (previews.length > 0) message.previews = previews;
  if (sticker) message.sticker = sticker;
  if (poll) message.poll = poll;
  const expires = data.expiresInSeconds ?? 0;
  // Signal starts the timer when the message is read; starting it when the
  // server received it errs on the side of deleting early, never keeping a
  // message longer than intended — and a replayed old message is already due.
  if (expires > 0) message.expiresAt = meta.timerStart + expires * 1000;
  return message;
}

/**
 * A one-line system message (timer changes, group updates, calls). `kind`
 * (e.g. 'timer', 'group', 'call') tags the id so it can't collide with a
 * real content message sharing the same (authorId, sentAt) — see
 * systemMessageId.
 */
export function systemMessage(
  meta: Pick<MessageMeta, 'conversationId' | 'authorId' | 'receivedAt'>,
  sentAt: number,
  text: string,
  kind: string,
): Message {
  return {
    id: systemMessageId(meta.authorId, sentAt, kind),
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
