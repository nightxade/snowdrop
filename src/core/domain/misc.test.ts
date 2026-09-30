import { describe, expect, it } from 'vitest';
import { AVATAR_HUE_COUNT, avatarHueIndex, colorForId, initialsFor } from './color';
import { fuzzyFilter, fuzzyMatch, fuzzyScore } from './fuzzy';
import {
  asConversationId,
  directConversationId,
  groupConversationId,
  messageId,
  parseConversationId,
  parseMessageId,
  pendingMessageId,
  isPendingMessageId,
} from './ids';
import { attachMentions, mentionsContact } from './mentions';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyReaction,
  summarizeReactions,
} from './messageOps';
import { makeMessage } from './testing';
import {
  formatClock,
  formatDayDivider,
  formatDuration,
  formatFullTimestamp,
  formatMessageTimestamp,
  formatRelative,
} from './time';

describe('ids', () => {
  it('builds and parses conversation ids', () => {
    expect(directConversationId('abc')).toBe('dm:abc');
    expect(groupConversationId('Zm9v')).toBe('group:Zm9v');
    expect(parseConversationId('group:Zm9v')).toEqual({ kind: 'group', target: 'Zm9v' });
    expect(parseConversationId('dm:')).toBeNull();
    expect(asConversationId('nope')).toBeNull();
  });

  it('builds and parses message ids', () => {
    const id = messageId('aci-1', 1700000000000);
    expect(parseMessageId(id)).toEqual({ authorId: 'aci-1', sentAt: 1700000000000 });
    expect(isPendingMessageId(pendingMessageId('n'))).toBe(true);
    expect(isPendingMessageId(id)).toBe(false);
  });
});

describe('colorForId', () => {
  it('is stable and within range', () => {
    expect(colorForId('alice')).toBe(colorForId('alice'));
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) {
      const idx = avatarHueIndex(`id-${i}`);
      expect(idx).toBeGreaterThanOrEqual(1);
      expect(idx).toBeLessThanOrEqual(AVATAR_HUE_COUNT);
      seen.add(idx);
    }
    expect(seen.size).toBe(AVATAR_HUE_COUNT);
    expect(colorForId('x')).toMatch(/^var\(--hearth-avatar-\d{1,2}\)$/u);
  });

  it('derives initials', () => {
    expect(initialsFor('Ines Okafor')).toBe('IO');
    expect(initialsFor('mira')).toBe('M');
    expect(initialsFor('  ')).toBe('?');
    expect(initialsFor('🎉 Party Crew')).toBe('🎉C');
  });
});

describe('fuzzy', () => {
  it('matches subsequences case- and accent-insensitively', () => {
    expect(fuzzyScore('clb', 'Climbing Club')).not.toBeNull();
    expect(fuzzyScore('lucia', 'Lucía Fenwick')).not.toBeNull();
    expect(fuzzyScore('xyz', 'Climbing Club')).toBeNull();
  });

  it('ranks exact > prefix > word-start > scattered', () => {
    const exact = fuzzyScore('work', 'work')!;
    const prefix = fuzzyScore('work', 'workshop')!;
    const wordStart = fuzzyScore('work', 'team work')!;
    const scattered = fuzzyScore('work', 'hwoarrk')!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(wordStart);
    expect(wordStart).toBeGreaterThan(scattered);
  });

  it('prefers word-start acronyms', () => {
    const ranked = fuzzyFilter('cc', ['Recycle centre', 'Climbing Club', 'accent'], (x) => x);
    expect(ranked[0]?.item).toBe('Climbing Club');
  });

  it('returns UTF-16 indices for highlighting', () => {
    expect(fuzzyMatch('ab', '😀a b')?.indices).toEqual([2, 4]);
  });

  it('treats an empty query as a neutral match', () => {
    expect(fuzzyScore('  ', 'anything')).toBe(0);
  });
});

describe('time formatting (UTC)', () => {
  const ts = Date.UTC(2026, 8, 29, 14, 2);
  it('formats 12/24h clocks', () => {
    expect(formatClock(ts, { clock24h: true })).toBe('14:02');
    expect(formatClock(ts, { clock24h: false })).toBe('2:02 PM');
    expect(formatClock(Date.UTC(2026, 0, 1, 0, 5), { clock24h: false })).toBe('12:05 AM');
    expect(formatClock(Date.UTC(2026, 0, 1, 12, 0), { clock24h: false })).toBe('12:00 PM');
  });

  it('formats day dividers and full timestamps', () => {
    expect(formatDayDivider(ts)).toBe('Tuesday, 29 September 2026');
    expect(formatFullTimestamp(ts, { clock24h: true })).toBe('Tuesday, 29 September 2026 at 14:02');
  });

  it('formats message timestamps relative to today', () => {
    const now = Date.UTC(2026, 8, 29, 20, 0);
    expect(formatMessageTimestamp(ts, now, { clock24h: true })).toBe('Today at 14:02');
    expect(formatMessageTimestamp(ts - 86_400_000, now, { clock24h: false })).toBe(
      'Yesterday at 2:02 PM',
    );
    expect(formatMessageTimestamp(ts - 3 * 86_400_000, now, { clock24h: true })).toBe(
      '26/09/2026 14:02',
    );
  });

  it('formats relative times', () => {
    expect(formatRelative(ts, ts + 10_000)).toBe('just now');
    expect(formatRelative(ts, ts + 3 * 60_000)).toBe('3m ago');
    expect(formatRelative(ts, ts + 2 * 3_600_000)).toBe('2h ago');
    expect(formatRelative(ts, ts + 4 * 86_400_000)).toBe('4d ago');
    expect(formatRelative(ts, ts + 30 * 86_400_000)).toBe('29 Sep 2026');
  });

  it('formats durations', () => {
    expect(formatDuration(0)).toBe('Off');
    expect(formatDuration(604_800)).toBe('1 week');
    expect(formatDuration(3 * 86_400)).toBe('3 days');
    expect(formatDuration(30)).toBe('30 seconds');
    expect(formatDuration(90)).toBe('90 seconds');
  });
});

describe('mentions', () => {
  it('pairs placeholders with ids in order', () => {
    const ranges = attachMentions('￼ and ￼', [{ start: 0, length: 3, style: 'bold' }], ['a', 'b']);
    expect(ranges).toEqual([
      { start: 0, length: 3, style: 'bold' },
      { start: 0, length: 1, mentionId: 'a' },
      { start: 6, length: 1, mentionId: 'b' },
    ]);
    expect(mentionsContact({ ranges }, 'b')).toBe(true);
  });
});

describe('messageOps', () => {
  const r = (emoji: string, authorId: string, at = 0) => ({ emoji, authorId, at });

  it('replaces an author reaction and removes only a matching one', () => {
    let list = applyReaction([], r('👍', 'a'), false);
    list = applyReaction(list, r('❤️', 'a', 1), false);
    expect(list).toEqual([r('❤️', 'a', 1)]);
    expect(applyReaction(list, r('👍', 'a'), true)).toEqual(list);
    expect(applyReaction(list, r('❤️', 'a'), true)).toEqual([]);
  });

  it('never downgrades status', () => {
    expect(advanceStatus('read', 'delivered')).toBe('read');
    expect(advanceStatus('sent', 'delivered')).toBe('delivered');
    expect(advanceStatus('failed', 'sent')).toBe('sent');
  });

  it('applies edits and deletions', () => {
    const m = makeMessage({ body: 'old', quote: { authorId: 'x', sentAt: 1, text: 'q' } });
    const edited = applyEdit(m, { body: 'new', ranges: [], editedAt: 5 });
    expect(edited).toMatchObject({ body: 'new', edits: 1, editedAt: 5 });
    const deleted = applyDelete(edited);
    expect(deleted).toMatchObject({ deleted: true, body: '' });
    expect(deleted.quote).toBeUndefined();
    expect(applyEdit(deleted, { body: 'zombie', ranges: [], editedAt: 6 }).body).toBe('');
  });

  it('summarises reactions by emoji', () => {
    expect(
      summarizeReactions([r('👍', 'a', 2), r('🔥', 'b', 1), r('👍', 'c', 3)]).map((s) => [
        s.emoji,
        s.authorIds,
      ]),
    ).toEqual([
      ['🔥', ['b']],
      ['👍', ['a', 'c']],
    ]);
  });
});
