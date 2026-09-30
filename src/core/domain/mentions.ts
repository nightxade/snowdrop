/**
 * Mention helpers.
 *
 * In Signal a mention is a U+FFFC placeholder in the body plus a range with the
 * mentioned ACI. The composer inserts the placeholder at the cursor and keeps
 * an ordered list of mentioned ids; markdown parsing moves placeholders around,
 * so we re-attach ids to placeholders *after* parsing, in document order.
 */
import { MENTION_PLACEHOLDER, type BodyRange, type Message } from './types';

/** Adds one mention range per placeholder, pairing them with ids in order. */
export function attachMentions(
  body: string,
  ranges: readonly BodyRange[],
  mentionIds: readonly string[],
): BodyRange[] {
  const out = [...ranges];
  let k = 0;
  for (let i = 0; i < body.length && k < mentionIds.length; i++) {
    if (body[i] === MENTION_PLACEHOLDER) {
      out.push({ start: i, length: 1, mentionId: mentionIds[k] as string });
      k++;
    }
  }
  return out.sort((a, b) => a.start - b.start || b.length - a.length);
}

export function mentionsOf(message: Pick<Message, 'ranges'>): string[] {
  return message.ranges.flatMap((r) => (r.mentionId === undefined ? [] : [r.mentionId]));
}

export function mentionsContact(message: Pick<Message, 'ranges'>, contactId: string): boolean {
  return message.ranges.some((r) => r.mentionId === contactId);
}
