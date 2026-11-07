import { hasGalleryItems, type GalleryKind, type Message, type MessageId } from '@/core/domain';

/** The part of a conversation window this reads: its messages, oldest first. */
export interface LiveWindow {
  ids: readonly MessageId[];
  byId: Readonly<Record<MessageId, Message | undefined>>;
  /** The window ends at the newest message, so nothing in the conversation is newer than it. */
  anchoredToPresent?: boolean;
  /** Messages the previous version of this window held and this one doesn't. */
  gone?: ReadonlySet<MessageId>;
}

const seqOf = (m: Message): number => m.seq ?? Number.MAX_SAFE_INTEGER;

/**
 * Brings a gallery tab's messages (newest first, as paged from the stored
 * history) up to date with the conversation's live window, so an open panel
 * keeps showing what the conversation does:
 *
 * - a message that was deleted, expired or lost its media is dropped; one
 *   whose media or links changed is replaced by its current version;
 * - a message the window no longer holds, though its place in the timeline is
 *   inside the window (a window is a contiguous slice), was removed: dropped.
 *   So is one that has just left a window reaching the present from its newest
 *   end (an expired last message); one that left from the oldest end, or from
 *   the newest end of a window that doesn't reach the present, was only evicted;
 * - a message that arrived since the panel opened (not in `known`), belongs on
 *   the tab and isn't there yet (new media) is added, unless it is older than
 *   what the tab has paged in so far (paging brings those). What the window
 *   held when the panel opened is the stored history's to say, not the window's.
 *
 * Returns the same array when nothing changed.
 */
export function reconcileGallery(
  messages: readonly Message[],
  kind: GalleryKind,
  done: boolean,
  window: LiveWindow,
  known: ReadonlySet<MessageId>,
): readonly Message[] {
  const firstId = window.ids[0];
  const lastId = window.ids.at(-1);
  const first = firstId === undefined ? undefined : window.byId[firstId];
  const last = lastId === undefined ? undefined : window.byId[lastId];
  if (!first || !last) return messages;
  const lowest = seqOf(first);
  const highest = seqOf(last);

  let changed = false;
  const kept: Message[] = [];
  for (const message of messages) {
    const current = window.byId[message.id];
    if (current) {
      if (!hasGalleryItems(current, kind)) {
        changed = true;
      } else if (
        current.attachments !== message.attachments ||
        current.previews !== message.previews
      ) {
        kept.push(current);
        changed = true;
      } else {
        kept.push(message);
      }
    } else if (
      message.seq !== undefined &&
      message.seq >= lowest &&
      (message.seq <= highest ||
        (window.anchoredToPresent === true && window.gone?.has(message.id) === true))
    ) {
      changed = true;
    } else {
      kept.push(message);
    }
  }

  const have = new Set(kept.map((m) => m.id));
  const oldest = kept.at(-1)?.seq;
  for (const id of window.ids) {
    const current = window.byId[id];
    if (!current || known.has(id) || have.has(id) || !hasGalleryItems(current, kind)) continue;
    if (!done && (oldest === undefined || seqOf(current) < oldest)) continue;
    kept.push(current);
    changed = true;
  }
  if (!changed) return messages;
  return kept.sort((a, b) => seqOf(b) - seqOf(a));
}
