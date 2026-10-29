/**
 * When a message may be edited, as Signal Desktop decides it
 * (`canEditMessage`, `isWithinMaxEdits`, `isTooOldToEditMessage`): the user's
 * own messages that have text, within a day of sending and at most ten
 * edits. The user's note-to-self is exempt from the age and count limits.
 * Incoming edits to a message more than two days old are ignored.
 * Pure: callers hand in the clock.
 */
import { DAY } from './time';
import { isPendingMessageId, parseConversationId, type ConversationId } from './ids';
import { isVoiceNote } from './voiceNote';
import type { Message } from './types';

/** An edit may be sent for this long after the message went out. */
export const EDIT_WINDOW_MS = DAY;
/** "Delete for everyone" works for this long after sending (Desktop's default limit). */
export const DELETE_WINDOW_MS = DAY;
/** The most times one message can be edited. */
export const MAX_EDITS = 10;
/** An incoming edit to a message older than this (server time) is dropped. */
export const INCOMING_EDIT_WINDOW_MS = 2 * DAY;

/** The user's own chat with themselves. */
export function isNoteToSelf(conversationId: ConversationId, selfId: string | null): boolean {
  if (selfId === null) return false;
  const parsed = parseConversationId(conversationId);
  return parsed?.kind === 'direct' && parsed.target === selfId;
}

type EditableFields = Pick<
  Message,
  | 'authorId'
  | 'conversationId'
  | 'sentAt'
  | 'kind'
  | 'deleted'
  | 'poll'
  | 'sticker'
  | 'attachments'
  | 'body'
  | 'edits'
>;

/**
 * Whether the content of `m` can be edited now, whoever's screen it is on:
 * ours, with text, not a poll, sticker or voice message, inside the window
 * and under the edit limit.
 */
export function isEditableContent(
  m: EditableFields,
  { selfId, now }: { selfId: string | null; now: number },
): boolean {
  if (selfId === null || m.authorId !== selfId) return false;
  if (m.kind !== 'normal' || m.deleted === true) return false;
  if (m.poll !== undefined || m.sticker !== undefined) return false;
  if (m.attachments.some(isVoiceNote)) return false;
  if (m.body === '') return false;
  if (isNoteToSelf(m.conversationId, selfId)) return true;
  return now - m.sentAt < EDIT_WINDOW_MS && (m.edits ?? 0) < MAX_EDITS;
}

/**
 * The action rule: editable content that has also left the device and not
 * failed (an unsent message is changed by its retry, not by an edit).
 */
export function canEditMessage(
  m: EditableFields & Pick<Message, 'id' | 'status'>,
  facts: { selfId: string | null; now: number },
): boolean {
  return !isPendingMessageId(m.id) && m.status !== 'failed' && isEditableContent(m, facts);
}

/**
 * Whether an edit that reached the server at `serverAt` must be ignored
 * because its target is too old (Desktop drops these; its own note-to-self
 * is exempt). The target's age is measured from its send time, the only
 * timestamp of it we keep.
 */
export function isTooOldToEdit(
  target: Pick<Message, 'conversationId' | 'sentAt'>,
  serverAt: number,
  selfId: string | null,
): boolean {
  if (isNoteToSelf(target.conversationId, selfId)) return false;
  return Math.abs(serverAt - target.sentAt) > INCOMING_EDIT_WINDOW_MS;
}

/**
 * Why `m` cannot be edited now, in words for the person who tried (undefined when it can be
 * edited, or when the reason is not one they could act on).
 */
export function editRefusal(
  m: EditableFields & Pick<Message, 'id' | 'status'>,
  facts: { selfId: string | null; now: number },
): string | undefined {
  if (canEditMessage(m, facts)) return undefined;
  const ours = facts.selfId !== null && m.authorId === facts.selfId;
  if (ours && !isNoteToSelf(m.conversationId, facts.selfId)) {
    if (facts.now - m.sentAt >= EDIT_WINDOW_MS) return 'Messages can only be edited for 24 hours.';
    if ((m.edits ?? 0) >= MAX_EDITS) return `A message can only be edited ${MAX_EDITS} times.`;
  }
  return "This message can't be edited.";
}

/**
 * Whether "delete for everyone" can still reach the others: Desktop offers it for one's own
 * messages (and admins' deletes in groups) for 24 hours after sending, never in note-to-self,
 * and recipients drop a later one without a word.
 */
export function isWithinDeleteWindow(
  m: Pick<Message, 'conversationId' | 'sentAt'>,
  now: number,
  selfId: string | null,
): boolean {
  return !isNoteToSelf(m.conversationId, selfId) && Math.abs(now - m.sentAt) <= DELETE_WINDOW_MS;
}
