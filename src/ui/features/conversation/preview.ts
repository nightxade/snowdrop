import { bodyToPlainText, POLL_EMOJI, pollPreviewText, type Message } from '@/core/domain';

export interface PreviewContext {
  selfId: string | null;
  isGroup: boolean;
  nameFor: (contactId: string) => string;
}

function firstName(name: string): string {
  return name.split(/\s+/u)[0] ?? name;
}

function attachmentLabel(message: Message): string | null {
  const [first] = message.attachments;
  if (!first) return null;
  const n = message.attachments.length;
  if (first.contentType.startsWith('image/')) return n > 1 ? `${n} photos` : 'Photo';
  if (first.contentType.startsWith('video/')) return 'Video';
  if (first.contentType.startsWith('audio/')) return 'Voice message';
  return first.fileName ?? 'File';
}

/** "Sticker", with its emoji when the source carries one. */
function stickerLabel(sticker: NonNullable<Message['sticker']>): string {
  return sticker.emoji ? `${sticker.emoji} Sticker` : 'Sticker';
}

/** "📊 Poll: Where to eat?", as Signal Desktop words it. */
function pollLabel(poll: NonNullable<Message['poll']>): string {
  return `${POLL_EMOJI} ${pollPreviewText(poll)}`;
}

/** One-line sidebar preview: "You: sounds good", "Mira: Photo", "Message deleted". */
export function previewText(message: Message | undefined, ctx: PreviewContext): string {
  if (!message) return '';
  if (message.kind === 'system') return message.systemText ?? '';
  const own = message.authorId === ctx.selfId;
  let text: string;
  if (message.deleted) text = 'Message deleted';
  else {
    const body = bodyToPlainText(message.body, message.ranges, ctx.nameFor)
      .replace(/\s+/gu, ' ')
      .trim();
    text =
      body ||
      (message.poll
        ? pollLabel(message.poll)
        : message.sticker
          ? stickerLabel(message.sticker)
          : attachmentLabel(message)) ||
      '';
  }
  if (own) return `You: ${text}`;
  if (ctx.isGroup) return `${firstName(ctx.nameFor(message.authorId))}: ${text}`;
  return text;
}
