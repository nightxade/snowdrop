import { describe, expect, it } from 'vitest';
import { groupMessages, type RenderItem } from './groupMessages';
import { conversationIdFor, makeMessage } from './testing';

const T0 = Date.UTC(2026, 8, 29, 10, 0); // Tuesday 29 Sep 2026, 10:00 UTC
const min = 60_000;
const conv = conversationIdFor('g');

const msg = (authorId: string, at: number, extra: Parameters<typeof makeMessage>[0] = {}) =>
  makeMessage({ conversationId: conv, authorId, sentAt: at, ...extra });

const shape = (items: RenderItem[]): string[] =>
  items.map((i) => {
    switch (i.type) {
      case 'day-divider':
        return 'day';
      case 'new-divider':
        return 'new';
      case 'system':
        return 'system';
      case 'message':
        return `${i.authorId}${i.continuation ? '+' : ''}`;
    }
  });

describe('groupMessages', () => {
  it('returns nothing for no messages', () => {
    expect(groupMessages([])).toEqual([]);
  });

  it('groups consecutive messages by the same author within 7 minutes', () => {
    const items = groupMessages([
      msg('a', T0),
      msg('a', T0 + 3 * min),
      msg('a', T0 + 10 * min), // 7 min after previous: still grouped
      msg('a', T0 + 18 * min), // 8 min gap: new group
      msg('b', T0 + 19 * min),
      msg('a', T0 + 20 * min),
    ]);
    expect(shape(items)).toEqual(['day', 'a', 'a+', 'a+', 'a', 'b', 'a']);
  });

  it('inserts day dividers and breaks groups across days', () => {
    const items = groupMessages([
      msg('a', T0),
      msg('a', Date.UTC(2026, 8, 29, 23, 58)),
      msg('a', Date.UTC(2026, 8, 30, 0, 1)),
    ]);
    expect(shape(items)).toEqual(['day', 'a', 'a', 'day', 'a']);
    expect(items[0]).toMatchObject({ type: 'day-divider' });
    expect(items[0]?.key).toMatch(/^day-2026-09-29-/u);
  });

  it('breaks groups on system messages', () => {
    const items = groupMessages([
      msg('a', T0),
      msg('a', T0 + min, { kind: 'system', systemText: 'Title changed' }),
      msg('a', T0 + 2 * min),
    ]);
    expect(shape(items)).toEqual(['day', 'a', 'system', 'a']);
  });

  it('gives replies a full header', () => {
    const items = groupMessages([
      msg('a', T0),
      msg('a', T0 + min, { quote: { authorId: 'b', sentAt: T0 - min, text: 'q' } }),
    ]);
    expect(shape(items)).toEqual(['day', 'a', 'a']);
  });

  it('places the new-messages divider before the first unread from others', () => {
    const items = groupMessages(
      [
        msg('a', T0),
        msg('me', T0 + min), // own message after cursor is not "new"
        msg('a', T0 + 2 * min),
        msg('a', T0 + 3 * min),
      ],
      { readCursor: T0, selfId: 'me' },
    );
    expect(shape(items)).toEqual(['day', 'a', 'me', 'new', 'a', 'a+']);
  });

  it('omits the divider when everything is read or no cursor is given', () => {
    const list = [msg('a', T0), msg('a', T0 + min)];
    expect(shape(groupMessages(list, { readCursor: T0 + min }))).not.toContain('new');
    expect(shape(groupMessages(list))).not.toContain('new');
  });

  it('places the divider at the top when the whole window is unread', () => {
    const items = groupMessages([msg('a', T0), msg('a', T0 + min)], { readCursor: T0 - 1 });
    expect(shape(items)).toEqual(['day', 'new', 'a', 'a+']);
  });

  it('respects a custom gap', () => {
    const items = groupMessages([msg('a', T0), msg('a', T0 + 2 * min)], { gapMs: min });
    expect(shape(items)).toEqual(['day', 'a', 'a']);
  });

  it('orders the new-messages divider by arrival (seq), not the sender clock', () => {
    // A skewed sender: sentAt in the past but it arrived after the cursor.
    const items = groupMessages([msg('a', T0, { seq: 1 }), msg('b', T0 - 60 * min, { seq: 2 })], {
      readCursor: 1,
    });
    expect(shape(items)).toEqual(['day', 'a', 'new', 'b']);
    // Negative gaps never continue a group.
    expect(
      shape(groupMessages([msg('a', T0, { seq: 1 }), msg('a', T0 - min, { seq: 2 })])),
    ).toEqual(['day', 'a', 'a']);
  });

  it('uses the client nonce as key so optimistic rows keep identity', () => {
    const items = groupMessages([msg('me', T0, { nonce: 'n1' })]);
    expect(items[1]?.key).toBe('n1');
  });
});
