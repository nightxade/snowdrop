/**
 * Turns a chronological message window into flat render items.
 *
 * The list is flat (not nested groups) because the virtualised message list
 * renders one row per item; grouping is expressed by `continuation`, which
 * tells a row to omit avatar and author header.
 */
import { dayKey } from './time';
import type { Message } from './types';

export const DEFAULT_GROUP_GAP_MS = 7 * 60_000;

export type RenderItem =
  | { type: 'day-divider'; key: string; at: number }
  | { type: 'new-divider'; key: 'new-divider'; at: number }
  | { type: 'system'; key: string; message: Message }
  | {
      type: 'message';
      key: string;
      message: Message;
      /** True when this row visually continues the previous author group. */
      continuation: boolean;
    };

export interface GroupOptions {
  /** Max gap between consecutive messages of one group. */
  gapMs?: number;
  /**
   * `sentAt` of the last message the user has read. The "new messages"
   * divider goes before the first later message from someone else.
   * Undefined = no divider.
   */
  readCursor?: number | undefined;
  /** Own messages never count as "new". */
  selfId?: string | undefined;
}

/** Stable React/virtualiser key: survives the pending → acknowledged id swap. */
export function messageKey(message: Message): string {
  return message.nonce ?? message.id;
}

/** `messages` must be sorted ascending by `sentAt`. */
export function groupMessages(
  messages: readonly Message[],
  options: GroupOptions = {},
): RenderItem[] {
  const gapMs = options.gapMs ?? DEFAULT_GROUP_GAP_MS;
  const { readCursor, selfId } = options;
  const items: RenderItem[] = [];

  let prev: Message | undefined;
  let prevDay: string | undefined;
  let newDividerPlaced = false;
  /** Set whenever something between two messages must break the group. */
  let broken = true;

  for (const message of messages) {
    const day = dayKey(message.sentAt);
    if (day !== prevDay) {
      items.push({ type: 'day-divider', key: `day-${day}`, at: message.sentAt });
      prevDay = day;
      broken = true;
    }

    if (
      !newDividerPlaced &&
      readCursor !== undefined &&
      message.sentAt > readCursor &&
      message.authorId !== selfId &&
      message.kind === 'normal'
    ) {
      items.push({ type: 'new-divider', key: 'new-divider', at: message.sentAt });
      newDividerPlaced = true;
      broken = true;
    }

    if (message.kind === 'system') {
      items.push({ type: 'system', key: messageKey(message), message });
      prev = message;
      broken = true;
      continue;
    }

    const continuation =
      !broken &&
      prev !== undefined &&
      prev.kind === 'normal' &&
      prev.authorId === message.authorId &&
      message.sentAt - prev.sentAt <= gapMs &&
      // A reply always gets a full header so its quote reads naturally.
      message.quote === undefined;

    items.push({ type: 'message', key: messageKey(message), message, continuation });
    prev = message;
    broken = false;
  }
  return items;
}
