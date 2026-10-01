/**
 * Autocomplete triggers: what the user is typing at the caret.
 * - `/cmd` only as the very first word of the message;
 * - `@name` after a space, bracket or at the start;
 * - `:shortcode` (2+ characters) likewise, so "10:30" or "http://" don't trigger.
 */
export type TriggerKind = 'mention' | 'emoji' | 'slash';

export interface Trigger {
  kind: TriggerKind;
  query: string;
  /** Replace text[start, end) on accept. */
  start: number;
  end: number;
}

const SLASH = /^\/([a-z][\w-]*)?$/iu;
const MENTION = /(^|[\s([{"'])@([^\s@]{0,32})$/u;
const EMOJI = /(^|[\s([{"'])(:([a-z0-9_+-]{2,32}))$/iu;

export function findTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = SLASH.exec(before);
  if (slash) return { kind: 'slash', query: slash[1] ?? '', start: 0, end: caret };
  const mention = MENTION.exec(before);
  if (mention) {
    const query = mention[2] ?? '';
    return { kind: 'mention', query, start: caret - query.length - 1, end: caret };
  }
  const emoji = EMOJI.exec(before);
  if (emoji) {
    const query = emoji[3] ?? '';
    return { kind: 'emoji', query, start: caret - query.length - 1, end: caret };
  }
  return null;
}
