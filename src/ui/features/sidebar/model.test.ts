import { describe, expect, it } from 'vitest';
import type { ConversationId, ConversationView } from '@/core/domain';
import { conversationIdFor, makeConversation } from '@/core/domain/testing';
import { attentionOf, HOME, needsAttention, type SpacesData } from '@/core/stores';
import {
  buildHomeSections,
  archivedIds,
  buildSpaceSections,
  globalOrder,
  navigationOrder,
  stepConversation,
  stepUnread,
  visibleIds,
  wantsAttention,
  type SidebarSection,
} from './model';

const id = conversationIdFor;

function view(key: string, patch: Partial<ConversationView> = {}): ConversationView {
  return {
    ...makeConversation({
      id: id(key),
      kind: key.startsWith('g') ? 'group' : 'direct',
      title: key,
    }),
    pinned: false,
    muted: false,
    archived: false,
    ...patch,
  };
}

const spaces = (assigned: Record<string, string[]> = {}): SpacesData => ({
  spaces: Object.fromEntries(
    Object.entries(assigned).map(([spaceId, keys]) => [
      spaceId,
      {
        id: spaceId,
        name: spaceId,
        hue: 1,
        muted: false,
        categories: [
          { id: `${spaceId}-a`, name: 'Chats', collapsed: false, conversationIds: keys.map(id) },
        ],
      },
    ]),
  ),
  rail: Object.keys(assigned).map((spaceId) => ({ type: 'space' as const, id: spaceId })),
  homeCollapsed: { conversations: false, direct: false, groups: false },
  seeded: true,
});

describe('buildHomeSections', () => {
  // Input order is "most recent first", as the views selector provides it.
  const views = [
    view('d1'),
    view('g1'),
    view('d2', { pinned: true }),
    view('g2'),
    view('d3', { archived: true }),
    view('g3', { pinned: true }),
  ];

  const split = { splitByType: true };

  it('by default lists DMs and groups together, pinned first, each by recency', () => {
    const sections = buildHomeSections(views, spaces());
    expect(sections.map((s) => [s.id, s.title, s.ids, s.pinnedCount])).toEqual([
      ['conversations', 'Conversations', [id('d2'), id('g3'), id('d1'), id('g1'), id('g2')], 2],
    ]);
  });

  it('splits DMs and groups, each pinned first, keeping recency order and skipping archived', () => {
    const sections = buildHomeSections(views, spaces(), split);
    expect(sections.map((s) => [s.id, s.ids, s.pinnedCount])).toEqual([
      ['direct', [id('d2'), id('d1')], 1],
      ['groups', [id('g3'), id('g1'), id('g2')], 1],
    ]);
  });

  it('hides groups that live in a space but keeps DMs in Home', () => {
    const sections = buildHomeSections(views, spaces({ work: ['g1', 'd1', 'g3'] }), split);
    expect(sections.find((s) => s.id === 'groups')?.ids).toEqual([id('g2')]);
    expect(sections.find((s) => s.id === 'direct')?.ids).toEqual([id('d2'), id('d1')]);
  });

  it('omits empty sections and carries the persisted collapse state', () => {
    const data = {
      ...spaces(),
      homeCollapsed: { conversations: false, direct: true, groups: false },
    };
    const sections = buildHomeSections([view('d1')], data, split);
    expect(sections).toEqual([
      { id: 'direct', title: 'Direct Messages', collapsed: true, ids: [id('d1')], pinnedCount: 0 },
    ]);
  });
});

describe('buildSpaceSections', () => {
  it('keeps category order and hides unknown or archived conversations', () => {
    const data = spaces({ work: ['g1', 'gone', 'g2'] });
    const known = { [id('g1')]: view('g1'), [id('g2')]: view('g2', { archived: true }) };
    expect(buildSpaceSections('work', data, known)[0]?.ids).toEqual([id('g1')]);
    expect(buildSpaceSections('missing', data, known)).toEqual([]);
  });

  it('leads each category with its pinned rows, which stay visible when it is collapsed (S5)', () => {
    const data = spaces({ work: ['g1', 'g2', 'g3'] });
    data.spaces.work!.categories[0]!.collapsed = true;
    const known = { [id('g1')]: view('g1'), [id('g2')]: view('g2'), [id('g3')]: view('g3') };
    const pinned = { ...known, [id('g3')]: view('g3', { pinned: true }) };
    const [section] = buildSpaceSections('work', data, pinned);
    expect(section?.ids).toEqual([id('g3'), id('g1'), id('g2')]);
    expect(section?.pinnedCount).toBe(1);
    expect(visibleIds(section!, null, () => false)).toEqual([id('g3')]);
    expect(buildSpaceSections('work', data, known)[0]?.pinnedCount).toBe(0);
  });
});

describe('visibility and navigation order', () => {
  const sections: SidebarSection[] = [
    { id: 'a', title: 'A', collapsed: false, ids: [id('d1'), id('d2')] },
    { id: 'b', title: 'B', collapsed: true, ids: [id('g1'), id('g2'), id('g3')] },
  ];
  const unread = { [id('g2')]: { count: 1, mentions: 0 } };
  /** The sidebar's rule: what a row shows an indicator for. */
  const attention =
    (
      counts: Record<string, { count: number; mentions: number }>,
      { muted = [], marked = [] }: { muted?: string[]; marked?: string[] } = {},
    ) =>
    (conversation: string) =>
      needsAttention(
        attentionOf(
          counts[conversation],
          muted.includes(conversation),
          marked.includes(conversation),
        ),
      );
  const shows = attention(unread);

  it('shows the open and unread rows of a collapsed section only', () => {
    expect(visibleIds(sections[1]!, null, shows)).toEqual([id('g2')]);
    expect(visibleIds(sections[1]!, id('g3'), shows)).toEqual([id('g2'), id('g3')]);
  });

  it('keeps in step with the row: a muted unread row hides, a marked-unread one and a muted mention show', () => {
    const counts = {
      [id('g1')]: { count: 4, mentions: 0 },
      [id('g2')]: { count: 2, mentions: 1 },
    };
    // g1 is muted with unread messages: no dot, so it hides. g2 is muted but mentions you: its badge shows.
    // g3 was marked unread by hand: its dot shows.
    expect(
      visibleIds(
        sections[1]!,
        null,
        attention(counts, { muted: [id('g1'), id('g2')], marked: [id('g3')] }),
      ),
    ).toEqual([id('g2'), id('g3')]);
  });

  it('also shows the pinned rows of a collapsed section, even unselected and read', () => {
    const withPinned: SidebarSection = {
      id: 'b',
      title: 'B',
      collapsed: true,
      ids: [id('g1'), id('g2'), id('g3')],
      pinnedCount: 1,
    };
    expect(visibleIds(withPinned, null, attention({}))).toEqual([id('g1')]);
    expect(visibleIds(withPinned, id('g3'), attention({}))).toEqual([id('g1'), id('g3')]);
  });

  it('walks exactly the rendered rows and clamps at the ends', () => {
    const order = navigationOrder(sections, null, shows);
    expect(order).toEqual([id('d1'), id('d2'), id('g2')]);
    expect(stepConversation(order, id('d2'), 1)).toBe(id('g2'));
    expect(stepConversation(order, id('g2'), 1)).toBe(id('g2'));
    expect(stepConversation(order, id('d1'), -1)).toBe(id('d1'));
    expect(stepConversation(order, null, 1)).toBe(id('d1'));
    expect(stepConversation(order, null, -1)).toBe(id('g2'));
    expect(stepConversation([], null, 1)).toBeNull();
  });
});

describe('next/previous unread', () => {
  const data = spaces({ work: ['g1', 'g2'] });
  const views = [view('d1'), view('d2'), view('g1'), view('g2'), view('g3')];
  const known = Object.fromEntries(views.map((v) => [v.id, v]));
  const order = globalOrder(buildHomeSections(views, data), data, known);

  it('orders Home first, then spaces in rail order', () => {
    expect(order.map((l) => `${l.space}:${l.id}`)).toEqual([
      `${HOME}:${id('d1')}`,
      `${HOME}:${id('d2')}`,
      `${HOME}:${id('g3')}`,
      `work:${id('g1')}`,
      `work:${id('g2')}`,
    ]);
  });

  it('wraps around, skips the current one and switches spaces', () => {
    const attention = new Set<ConversationId>([id('d1'), id('g2')]);
    const has = (c: ConversationId) => attention.has(c);
    expect(stepUnread(order, { space: HOME, id: id('d1') }, 1, has)).toEqual({
      space: 'work',
      id: id('g2'),
    });
    expect(stepUnread(order, { space: 'work', id: id('g2') }, 1, has)).toEqual({
      space: HOME,
      id: id('d1'),
    });
    expect(stepUnread(order, null, -1, has)).toEqual({ space: 'work', id: id('g2') });
    expect(stepUnread(order, { space: HOME, id: id('d1') }, 1, (c) => c === id('d1'))).toBeNull();
  });

  it('muted conversations only count when they mention you', () => {
    expect(wantsAttention({ count: 3, mentions: 0 }, true)).toBe(false);
    expect(wantsAttention({ count: 3, mentions: 1 }, true)).toBe(true);
    expect(wantsAttention({ count: 1, mentions: 0 }, false)).toBe(true);
    expect(wantsAttention(undefined, false)).toBe(false);
    expect(wantsAttention(undefined, false, true)).toBe(true);
    expect(wantsAttention(undefined, true, true)).toBe(false);
  });
});

describe('archivedIds', () => {
  const views = [
    view('d1', { archived: true }),
    view('g1', { archived: true }),
    view('g2', { archived: true }),
    view('g3'),
  ];
  const placed = spaces({ work: ['g2', 'g3'] });

  it('Home lists the archived DMs and groups that are not in a space', () => {
    expect(archivedIds(views, HOME, placed)).toEqual([id('d1'), id('g1')]);
  });

  it('a space lists only its own archived conversations', () => {
    expect(archivedIds(views, 'work', placed)).toEqual([id('g2')]);
    expect(archivedIds(views, 'nowhere', placed)).toEqual([]);
  });
});
