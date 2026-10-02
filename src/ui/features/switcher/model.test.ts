import { describe, expect, it } from 'vitest';
import type { ConversationId, ConversationView } from '@/core/domain';

const asConversationId = (id: string) => id as ConversationId;
import { parseQuery, searchSwitcher, type SwitcherInput } from './model';

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

describe('switcher model', () => {
  it('parses prefixes', () => {
    expect(parseQuery('>set')).toEqual({ scope: 'commands', text: 'set' });
    expect(parseQuery('  @ ana')).toEqual({ scope: 'direct', text: 'ana' });
    expect(parseQuery('#climb')).toEqual({ scope: 'groups', text: 'climb' });
    expect(parseQuery('*crux')).toEqual({ scope: 'spaces', text: 'crux' });
    expect(parseQuery('plain')).toEqual({ scope: 'all', text: 'plain' });
  });

  it('ranks word-start matches first and never shows archived conversations', () => {
    const result = keys(searchSwitcher('clc', input()));
    expect(result[0]).toBe('conversation:group:climb');
    expect(result).not.toContain('conversation:group:old');
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
});
