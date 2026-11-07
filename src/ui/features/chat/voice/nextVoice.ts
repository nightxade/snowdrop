import { isVoiceNote, type Attachment, type Message, type MessageId } from '@/core/domain';

/** What a player is keyed by: its message and attachment. */
export const voicePlayKey = (messageId: MessageId, attachmentId: string): string =>
  `${messageId}\u0000${attachmentId}`;

/**
 * The voice note after the one in `messageId`: the next message down the
 * conversation that has one, skipping everything between (as Signal Desktop's
 * consecutive playback does). `ids` is the loaded window, oldest first.
 */
export function nextVoiceNote(
  ids: readonly MessageId[],
  byId: Readonly<Record<MessageId, Message | undefined>>,
  messageId: MessageId,
): { message: Message; attachment: Attachment } | undefined {
  const at = ids.indexOf(messageId);
  if (at < 0) return undefined;
  for (const id of ids.slice(at + 1)) {
    const message = byId[id];
    if (!message || message.deleted) continue;
    const voice = message.attachments.find(isVoiceNote);
    if (voice) return { message, attachment: voice };
  }
  return undefined;
}

/** The play key of the voice note after the one in `messageId`. */
export function nextVoiceKey(
  ids: readonly MessageId[],
  byId: Readonly<Record<MessageId, Message | undefined>>,
  messageId: MessageId,
): string | undefined {
  const next = nextVoiceNote(ids, byId, messageId);
  return next && voicePlayKey(next.message.id, next.attachment.id);
}
