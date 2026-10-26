/**
 * What of a message can be forwarded, as Signal Desktop's forward action
 * decides it: ordinary content only. Polls, deleted messages and system
 * notices are never forwarded, and neither is anything with nothing in it.
 * (Signal's view-once media and gift badges, which Desktop also refuses,
 * don't exist in this model.) Messages of ours that haven't gone out yet, or
 * failed to, have nothing to forward from.
 */
import { isPendingMessageId } from './ids';
import { isVoiceNote } from './voiceNote';
import type { Message } from './types';

/** Desktop lets a message go to at most this many chats at once. */
export const MAX_FORWARD_TARGETS = 5;

export function isForwardable(
  m: Pick<
    Message,
    'id' | 'kind' | 'deleted' | 'poll' | 'status' | 'sticker' | 'attachments' | 'body'
  >,
): boolean {
  if (m.kind !== 'normal' || m.deleted === true || m.poll !== undefined) return false;
  if (isPendingMessageId(m.id) || m.status === 'failed') return false;
  return m.sticker !== undefined || m.attachments.length > 0 || m.body.trim() !== '';
}

/**
 * Whether the text and files can be changed before forwarding (Desktop's
 * `isDraftEditable`): not a sticker, and not a voice message, which go out
 * exactly as they are.
 */
export function isForwardEditable(m: Pick<Message, 'sticker' | 'attachments'>): boolean {
  return m.sticker === undefined && !m.attachments.some(isVoiceNote);
}
