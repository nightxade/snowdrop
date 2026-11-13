import { describe, expect, it } from 'vitest';
import type { ConversationId, ConversationView } from '@/core/domain';

const asConversationId = (id: string) => id as ConversationId;
import { parseQuery, searchConversations, searchSwitcher, type SwitcherInput } from './model';

const view = (
  id: string,
  title: string,
  kind: 'direct' | 'group',
  lastActivityAt: number,
  extra: Partial<ConversationView> = {},
): ConversationView => ({
  id: asConversationId(id),
  kind,
  title,
  memberIds: [],
  adminIds: [],
  expireTimerSec: 0,
  lastActivityAt,
  pinned: false,
  muted: false,
  archived: false,
  ...extra,
});

const input = (over: Partial<SwitcherInput> = {}): SwitcherInput => ({
  views: [
    view('group:climb', 'Climbing Club', 'group', 50),
    view('group:lib', 'Cool Library', 'group', 90),
    view('dm:ana', 'Ana Lima', 'direct', 80),
    view('dm:cleo', 'Cleo Bright', 'direct', 70),
    view('group:old', 'Clubhouse archive', 'group', 10, { archived: true }),
  ],
  unread: {},
  spaces: [
    { id: 'space-1', name: 'Crux', hue: 3, conversationIds: [asConversationId('group:climb')] },
  ],
  commands: [
    { id: 'core.openSettings', title: 'Open settings', category: 'App' },
    { id: 'core.toggleMemberList', title: 'Toggle member list', category: 'View' },
  ],
  isMuted: () => false,
  ...over,
});

const keys = (sections: ReturnType<typeof searchSwitcher>) =>
  sections.flatMap((s) => s.items.map((i) => i.key));

describe('a space in the switcher shows what the rail shows', () => {
  const space = (ids: string[]) => ({
    id: 'space-x',
    name: 'Crux',
    hue: 3,
    conversationIds: ids.map(asConversationId),
  });
  const dot = (data: SwitcherInput) => {
    const item = searchSwitcher('*crux', data)
      .flatMap((s) => s.items)
      .find((i) => i.kind === 'space');
    return item?.kind === 'space' ? { unread: item.unread, mentions: item.mentions } : null;
  };

  it('ignores muted and archived chats, and counts one marked unread', () => {
    const views = [
      view('g1', 'One', 'group', 1, { muted: true }),
      view('g2', 'Two', 'group', 1, { archived: true }),
      view('g3', 'Three', 'group', 1),
    ];
    const quiet = input({
      views,
      spaces: [space(['g1', 'g2', 'g3'])],
      unread: { g1: { count: 4, mentions: 0 }, g2: { count: 9, mentions: 5 } },
      isMuted: (v) => v.muted === true,
    });
    expect(dot(quiet)).toEqual({ unread: false, mentions: 0 });
    const marked = input({
      views: [...views.slice(0, 2), view('g3', 'Three', 'group', 1, { markedUnread: true })],
      spaces: [space(['g1', 'g2', 'g3'])],
      unread: quiet.unread,
      isMuted: quiet.isMuted,
    });
    expect(dot(marked)).toEqual({ unread: true, mentions: 0 });
  });

  it('shows only mentions for a muted space, as the rail does', () => {
    const data = input({
      views: [view('g1', 'One', 'group', 1)],
      spaces: [space(['g1'])],
      unread: { g1: { count: 4, mentions: 2 } },
      isMuted: () => true,
    });
    expect(dot(data)).toEqual({ unread: false, mentions: 2 });
  });
});

describe('searchConversations', () => {
  it('finds the same chats as the @ and # scopes, without the query syntax', () => {
    const data = input();
    // The global search's people and groups sections keep leaving archived chats out.
    const live = { ...data, views: data.views.filter((v) => !v.archived) };
    for (const [kind, prefix] of [
      ['direct', '@'],
      ['group', '#'],
    ] as const) {
      for (const text of ['c', 'cl', 'li']) {
        const viaQuery = searchSwitcher(`${prefix}${text}`, live).flatMap((s) => s.items);
        expect(searchConversations(text, kind, data)).toEqual(viaQuery);
      }
    }
    expect(searchConversations('c', 'direct', data).map((i) => i.key)).toEqual([
      'conversation:dm:cleo',
    ]);
  });

  it('returns nothing for empty text, hides archived chats and honours the limit', () => {
    const data = input();
    expect(searchConversations('  ', 'group', data)).toEqual([]);
    expect(searchConversations('club', 'group', data).map((i) => i.id)).toEqual([
      asConversationId('group:climb'),
    ]);
    expect(searchConversations('c', 'group', { ...data, limit: 1 })).toHaveLength(1);
  });

  it('treats a leading prefix character as part of the text', () => {
    const data = input({ views: [view('group:a', '#general', 'group', 1)] });
    expect(searchConversations('#gen', 'group', data).map((i) => i.title)).toEqual(['#general']);
    // As a query, ">" would pick the commands scope; here it is just a character.
    expect(searchConversations('>gen', 'group', data)).toEqual([]);
  });
});

describe('switcher model', () => {
  it('parses prefixes', () => {
    expect(parseQuery('>set')).toEqual({ scope: 'commands', text: 'set' });
    expect(parseQuery('  @ ana')).toEqual({ scope: 'direct', text: 'ana' });
    expect(parseQuery('#climb')).toEqual({ scope: 'groups', text: 'climb' });
    expect(parseQuery('*crux')).toEqual({ scope: 'spaces', text: 'crux' });
    expect(parseQuery('plain')).toEqual({ scope: 'all', text: 'plain' });
  });

  it('ranks word-start matches first', () => {
    const result = keys(searchSwitcher('clc', input()));
    expect(result[0]).toBe('conversation:group:climb');
  });

  it('finds archived chats when searching, below live ones of equal score', () => {
    const data = input({
      views: [
        view('group:a', 'Cabin', 'group', 1, { archived: true }),
        view('group:b', 'Cabin', 'group', 2),
      ],
    });
    const items = searchSwitcher('cabin', data).flatMap((s) => s.items);
    expect(items.map((i) => i.key)).toEqual(['conversation:group:b', 'conversation:group:a']);
    expect(items.map((i) => i.kind === 'conversation' && i.archived)).toEqual([false, true]);
    expect(keys(searchSwitcher('@clubhouse', data))).toEqual([]);
    expect(keys(searchSwitcher('#cabin', data))).toHaveLength(2);
  });

  it('keeps archived chats out of the empty-query lists', () => {
    const sections = searchSwitcher('', input());
    expect(keys(sections)).not.toContain('conversation:group:old');
  });

  it('scopes results by prefix', () => {
    expect(keys(searchSwitcher('@c', input()))).toEqual(['conversation:dm:cleo']);
    expect(
      keys(searchSwitcher('#c', input())).every((k) => k.startsWith('conversation:group')),
    ).toBe(true);
    expect(keys(searchSwitcher('*', input()))).toEqual(['space:space-1']);
    const browse = searchSwitcher('>', input());
    expect(browse.map((sec) => sec.heading)).toEqual(['App', 'View']);
    expect(keys(browse)).toEqual(['command:core.openSettings', 'command:core.toggleMemberList']);
    expect(keys(searchSwitcher('>member', input()))).toEqual(['command:core.toggleMemberList']);
  });

  it('ranks commands below equally good places when unscoped', () => {
    const result = keys(
      searchSwitcher('open', input({ views: [view('group:o', 'Open settings', 'group', 1)] })),
    );
    expect(result).toEqual(['conversation:group:o', 'command:core.openSettings']);
  });

  it('shows the space a group lives in', () => {
    const [section] = searchSwitcher('climbing', input());
    const item = section?.items[0];
    expect(item?.kind === 'conversation' && item.spaceName).toBe('Crux');
  });

  it('shows unread (mentions first) then recent on an empty query, skipping the open one', () => {
    const sections = searchSwitcher(
      '',
      input({
        unread: {
          'group:lib': { count: 3, mentions: 0 },
          'dm:cleo': { count: 1, mentions: 1 },
        },
        current: asConversationId('dm:ana'),
      }),
    );
    expect(sections.map((s) => s.id)).toEqual(['unread', 'recent']);
    expect(sections[0]?.items.map((i) => i.key)).toEqual([
      'conversation:dm:cleo',
      'conversation:group:lib',
    ]);
    expect(sections[1]?.items.map((i) => i.key)).toEqual(['conversation:group:climb']);
  });

  it('leaves muted unread out of the unread group unless it mentions you', () => {
    const sections = searchSwitcher(
      '',
      input({
        unread: { 'group:lib': { count: 3, mentions: 0 } },
        isMuted: (v) => v.id === 'group:lib',
      }),
    );
    expect(sections.find((s) => s.id === 'unread')).toBeUndefined();
  });

  it('unread can only reorder near-equal matches (S2)', () => {
    const views = [
      view('group:a', 'Garden', 'group', 1),
      view('group:b', 'Gardening club', 'group', 2),
    ];
    const order = (unread: SwitcherInput['unread']) =>
      keys(searchSwitcher('garden', input({ views, unread })));
    // An exact title beats a mentioned, longer one.
    expect(order({ 'group:b': { count: 9, mentions: 3 } })[0]).toBe('conversation:group:a');
  });

  it('a word-start command match is only lightly penalised (S2)', () => {
    const result = keys(
      searchSwitcher(
        'dark',
        input({
          views: [view('group:d', 'Darts kids', 'group', 1)],
          commands: [{ id: 'core.theme.dusk', title: 'Theme: Dusk, dark', category: 'Theme' }],
        }),
      ),
    );
    expect(result).toContain('command:core.theme.dusk');
  });

  it('drops weak tail matches below 40% of the best (S2)', () => {
    const result = keys(
      searchSwitcher(
        'climbing',
        input({
          views: [
            view('group:c', 'Climbing', 'group', 1),
            view('group:x', 'Cool lime inbox brainstorming', 'group', 2),
          ],
        }),
      ),
    );
    expect(result).toEqual(['conversation:group:c']);
  });
});
