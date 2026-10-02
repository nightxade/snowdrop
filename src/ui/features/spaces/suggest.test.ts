import { describe, expect, it } from 'vitest';
import type { ConversationId } from '@/core/domain';

const asConversationId = (id: string) => id as ConversationId;
import { suggestConversations, type SuggestCandidate } from './suggest';

const c = (
  id: string,
  kind: 'direct' | 'group',
  members: string[],
  at: number,
  spaceId: string | null = null,
): SuggestCandidate => ({
  id: asConversationId(id),
  kind,
  memberIds: ['me', ...members],
  lastActivityAt: at,
  spaceId,
});

const pool = [
  c('group:crux', 'group', ['ana', 'bo', 'cy'], 10),
  c('group:trip', 'group', ['ana', 'bo'], 30),
  c('group:work', 'group', ['dee'], 50),
  c('dm:ana', 'direct', ['ana'], 40),
  c('group:old', 'group', ['ana', 'bo'], 20, 'space-x'),
];

describe('space suggestions', () => {
  it('ranks by people shared with the picks, groups and unorganised first', () => {
    const picks = new Set([asConversationId('group:crux')]);
    expect(suggestConversations(pool, picks, 'me')).toEqual([
      { id: 'group:trip', shared: 2 },
      { id: 'group:old', shared: 2 },
      { id: 'dm:ana', shared: 1 },
    ]);
  });

  it('never counts yourself as shared', () => {
    const picks = new Set([asConversationId('group:work')]);
    expect(suggestConversations(pool, picks, 'me')).toEqual([]);
  });

  it('suggests recent unorganised groups when nothing is picked', () => {
    expect(suggestConversations(pool, new Set(), 'me', 2).map((s) => s.id)).toEqual([
      'group:work',
      'group:trip',
    ]);
  });
});
