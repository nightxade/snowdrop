/**
 * Turns a chronological message window into flat render items.
 *
 * The list is flat (not nested groups) because the virtualised message list
 * renders one row per item; grouping is expressed by `continuation`, which
 * tells a row to omit avatar and author header.
 *
 * Items reference messages by id rather than embedding them: rows subscribe
 * to their own message, so a reaction or edit re-renders one row instead of
 * invalidating the whole list. Layout only depends on fields that never
 * change after insertion (author, sentAt, kind, quote, seq), which lets
 * callers memoise on the id list alone.
 */
import type { MessageId } from './ids';
import { dayKey } from './time';
import type { Message } from './types';

export const DEFAULT_GROUP_GAP_MS = 7 * 60_000;

export type RenderItem =
  | { type: 'day-divider'; key: string; at: number }
  | { type: 'new-divider'; key: 'new-divider' }
  | { type: 'system'; key: string; id: MessageId }
  | {
      type: 'message';
      key: string;
      id: MessageId;
      authorId: string;
      /** True when this row visually continues the previous author group. */
      continuation: boolean;
    };

/** The fields grouping reads; all immutable once a message is stored. */
export type LayoutMessage = Pick<
  Message,
  'id' | 'authorId' | 'sentAt' | 'kind' | 'quote' | 'seq' | 'nonce'
>;

export interface GroupOptions {
  /** Max gap between consecutive messages of one group. */
  gapMs?: number;
  /**
   * `seq` of the last read message (a snapshot taken when the conversation
   * was opened). The "new messages" divider goes before the first later
   * message from someone else. Undefined = no divider.
   */
  readCursor?: number | undefined;
  /** Own messages never count as "new". */
  selfId?: string | undefined;
}

/** Stable React/virtualiser key: survives the pending → acknowledged id swap. */
export function messageKey(message: Pick<Message, 'id' | 'nonce'>): string {
  return message.nonce ?? message.id;
}

/** `messages` must be in timeline order (ascending `seq`). */
export function groupMessages(
  messages: readonly LayoutMessage[],
  options: GroupOptions = {},
): RenderItem[] {
  const gapMs = options.gapMs ?? DEFAULT_GROUP_GAP_MS;
  const { readCursor, selfId } = options;
  const items: RenderItem[] = [];

  let prev: LayoutMessage | undefined;
  let prevDay: string | undefined;
  let newDividerPlaced = false;
  /** Set whenever something between two messages must break the group. */
  let broken = true;

  for (const message of messages) {
    const key = messageKey(message);
    const day = dayKey(message.sentAt);
    if (day !== prevDay) {
      // Keyed by the first message too: skewed clocks can revisit a day.
      items.push({ type: 'day-divider', key: `day-${day}-${key}`, at: message.sentAt });
      prevDay = day;
      broken = true;
    }

    if (
      !newDividerPlaced &&
      readCursor !== undefined &&
      message.seq !== undefined &&
      message.seq > readCursor &&
      message.authorId !== selfId &&
      message.kind === 'normal'
    ) {
      items.push({ type: 'new-divider', key: 'new-divider' });
      newDividerPlaced = true;
      broken = true;
    }

    if (message.kind === 'system') {
      items.push({ type: 'system', key, id: message.id });
      prev = message;
      broken = true;
      continue;
    }

    const gap = prev === undefined ? Infinity : message.sentAt - prev.sentAt;
    const continuation =
      !broken &&
      prev !== undefined &&
      prev.kind === 'normal' &&
      prev.authorId === message.authorId &&
      // Negative gaps come from clock skew; don't pretend those are one burst.
      gap >= 0 &&
      gap <= gapMs &&
      // A reply always gets a full header so its quote reads naturally.
      message.quote === undefined;

    items.push({ type: 'message', key, id: message.id, authorId: message.authorId, continuation });
    prev = message;
    broken = false;
  }
  return items;
}
