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
  systemMessageId,
} from './ids';
import { attachMentions, mentionsContact } from './mentions';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyReaction,
  applyRecipientReceipt,
  mergeDuplicate,
  mergeOutgoingCommit,
  mergeReceipts,
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

  it('(regression) round-trips a system message id through parseMessageId', () => {
    const sys = systemMessageId('aci-1', 1700000000000, 'timer');
    expect(sys).toBe('aci-1:1700000000000:sys:timer');
    expect(parseMessageId(sys)).toEqual({ authorId: 'aci-1', sentAt: 1700000000000 });
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
    expect(colorForId('x')).toMatch(/^var\(--snowdrop-avatar-\d{1,2}\)$/u);
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

  it('finds matches a greedy scan would miss', () => {
    expect(fuzzyMatch('ma', 'Emma Moss')?.indices).toEqual([2, 3]);
    expect(fuzzyMatch('bc', 'abc b')?.indices).toEqual([1, 2]);
    expect(fuzzyMatch('clb', 'Climbing Club')?.indices).toEqual([0, 1, 4]);
    // Consecutive letters beat jumping to a later word start.
    expect(fuzzyMatch('ar', 'Mark Rogers')?.indices).toEqual([1, 2]);
    expect(fuzzyMatch('team', 'Steam Team x')?.indices).toEqual([6, 7, 8, 9]);
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

  it('records a recipient receipt, never downgrading a recipient already read', () => {
    let receipts = applyRecipientReceipt(undefined, 'alice', 'delivered', 100);
    expect(receipts).toEqual({ alice: { status: 'delivered', at: 100 } });
    receipts = applyRecipientReceipt(receipts, 'alice', 'read', 200);
    expect(receipts).toEqual({ alice: { status: 'read', at: 200 } });
    // Out of order: a stale "delivered" behind the "read" already recorded is dropped.
    receipts = applyRecipientReceipt(receipts, 'alice', 'delivered', 300);
    expect(receipts).toEqual({ alice: { status: 'read', at: 200 } });
    // A second recipient is tracked independently.
    receipts = applyRecipientReceipt(receipts, 'bob', 'delivered', 150);
    expect(receipts).toEqual({
      alice: { status: 'read', at: 200 },
      bob: { status: 'delivered', at: 150 },
    });
  });

  it('merges per-recipient receipts from two copies, keeping the higher status each', () => {
    const existing = {
      alice: { status: 'read' as const, at: 10 },
      bob: { status: 'delivered' as const, at: 20 },
    };
    const incoming = {
      alice: { status: 'delivered' as const, at: 999 },
      carol: { status: 'read' as const, at: 5 },
    };
    expect(mergeReceipts(existing, incoming)).toEqual({
      alice: { status: 'read', at: 10 },
      bob: { status: 'delivered', at: 20 },
      carol: { status: 'read', at: 5 },
    });
    expect(mergeReceipts(undefined, undefined)).toBeUndefined();
    expect(mergeReceipts(existing, undefined)).toBe(existing);
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

  it('replaces the preview wholesale on edit, dropping it when the edit carries none', () => {
    const m = makeMessage({ body: 'old', previews: [{ url: 'https://a.example' }] });
    const edited = applyEdit(m, {
      body: 'new https://b.example',
      ranges: [],
      editedAt: 5,
      previews: [{ url: 'https://b.example', title: 'B' }],
    });
    expect(edited.previews).toEqual([{ url: 'https://b.example', title: 'B' }]);
    const withoutPreview = applyEdit(edited, { body: 'plain text', ranges: [], editedAt: 6 });
    expect(withoutPreview.previews).toBeUndefined();
  });

  it('ignores edits older than the one shown (out-of-order delivery)', () => {
    const m = makeMessage({ body: 'v0' });
    const v2 = applyEdit(m, { body: 'v2', ranges: [], editedAt: 3000 });
    const stale = applyEdit(v2, { body: 'v1', ranges: [], editedAt: 2000 });
    expect(stale).toMatchObject({ body: 'v2', edits: 1 });
  });

  it('records who deleted a message when it was an admin', () => {
    const m = makeMessage({ authorId: 'a', pinned: true });
    expect(applyDelete(m, 'admin').deletedBy).toBe('admin');
    expect(applyDelete(m, 'a').deletedBy).toBeUndefined();
    expect(applyDelete(m).pinned).toBeUndefined();
  });

  it('merges duplicates without losing later events', () => {
    const stored = makeMessage({
      body: 'edited',
      edits: 1,
      editedAt: 50,
      status: 'read',
      seq: 7,
      reactions: [r('👍', 'b')],
      receipts: { alice: { status: 'read', at: 10 } },
    });
    const redelivered = makeMessage({
      body: 'original',
      status: 'delivered',
      seq: 99,
      receipts: { alice: { status: 'delivered', at: 999 }, bob: { status: 'delivered', at: 5 } },
    });
    expect(mergeDuplicate(stored, redelivered)).toMatchObject({
      body: 'edited',
      status: 'read',
      seq: 7,
      reactions: [r('👍', 'b')],
      // Alice's earlier "read" isn't downgraded by the redelivery's "delivered";
      // Bob's receipt (only on the redelivered copy) still comes through.
      receipts: { alice: { status: 'read', at: 10 }, bob: { status: 'delivered', at: 5 } },
    });
    const newer = makeMessage({ body: 'newer', editedAt: 60, edits: 2 });
    expect(mergeDuplicate(stored, newer)).toMatchObject({ body: 'newer', edits: 2, seq: 7 });
  });

  it('(regression) commitOutgoing merge keeps our seq, nonce and attachment preview over a sync echo', () => {
    // A sync-transcript echo of our own send landed first and created the row
    // under the final (author:sentAt) id, with its own independently
    // allocated seq and no nonce (backend events never carry one) or local
    // preview url.
    const echo = makeMessage({
      authorId: 'me',
      sentAt: 100,
      seq: 42,
      status: 'read',
      reactions: [r('👍', 'friend')],
      attachments: [{ id: 'att-1', contentType: 'image/png' }],
    });
    // Our own send's result: the seq reserved when it was optimistically
    // shown, its nonce, and the attachment's local preview url.
    const final = makeMessage({
      authorId: 'me',
      sentAt: 100,
      seq: 7,
      status: 'sent',
      nonce: 'nonce-1',
      attachments: [{ id: 'att-1', contentType: 'image/png', url: 'blob:preview' }],
    });
    expect(mergeOutgoingCommit(echo, final)).toMatchObject({
      seq: 7,
      nonce: 'nonce-1',
      attachments: [{ id: 'att-1', contentType: 'image/png', url: 'blob:preview' }],
      // Still keeps what a duplicate delivery should: the max status and
      // whatever already landed on the stored row (reactions, here).
      status: 'read',
      reactions: [r('👍', 'friend')],
    });
  });

  it('(regression) commitOutgoing merge keeps our preview over a sync echo with none', () => {
    const echo = makeMessage({ authorId: 'me', sentAt: 101, seq: 43 });
    const final = makeMessage({
      authorId: 'me',
      sentAt: 101,
      seq: 8,
      previews: [{ url: 'https://example.com', title: 'Example' }],
    });
    expect(mergeOutgoingCommit(echo, final).previews).toEqual([
      { url: 'https://example.com', title: 'Example' },
    ]);
  });

  it('summarises reactions by emoji', () => {
    expect(
      summarizeReactions([r('👍', 'a', 2), r('🎯', 'b', 1), r('👍', 'c', 3)]).map((s) => [
        s.emoji,
        s.authorIds,
      ]),
    ).toEqual([
      ['🎯', ['b']],
      ['👍', ['a', 'c']],
    ]);
  });
});
