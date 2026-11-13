import { messageSummary, type Message } from '@/core/domain';

export interface PreviewContext {
  selfId: string | null;
  isGroup: boolean;
  nameFor: (contactId: string) => string;
}

function firstName(name: string): string {
  return name.split(/\s+/u)[0] ?? name;
}

/** One-line sidebar preview: "You: sounds good", "Mira: Photo", "Message deleted". */
export function previewText(message: Message | undefined, ctx: PreviewContext): string {
  if (!message) return '';
  if (message.kind === 'system') return message.systemText ?? '';
  const own = message.authorId === ctx.selfId;
  const text = message.deleted ? 'Message deleted' : messageSummary(message, ctx.nameFor);
  if (own) return `You: ${text}`;
  if (ctx.isGroup) return `${firstName(ctx.nameFor(message.authorId))}: ${text}`;
  return text;
}
