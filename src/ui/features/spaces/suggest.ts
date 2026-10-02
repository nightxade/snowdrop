/**
 * Create/Edit Space suggestions (PLAN §4.2): conversations that share the
 * most members with what's already picked. With nothing picked, the most
 * recently active groups not yet in a space. Pure, for tests.
 */
import type { ConversationId } from '@/core/domain';

export interface SuggestCandidate {
  id: ConversationId;
  kind: 'direct' | 'group';
  memberIds: readonly string[];
  lastActivityAt: number;
  /** Space it already belongs to (other than the one being edited). */
  spaceId: string | null;
}

export function suggestConversations(
  candidates: readonly SuggestCandidate[],
  selected: ReadonlySet<ConversationId>,
  selfId: string | null,
  limit = 5,
): { id: ConversationId; shared: number }[] {
  const picked = candidates.filter((c) => selected.has(c.id));
  const people = new Set<string>();
  for (const c of picked) for (const m of c.memberIds) if (m !== selfId) people.add(m);
  const pool = candidates.filter((c) => !selected.has(c.id));
  if (people.size === 0) {
    return pool
      .filter((c) => c.kind === 'group' && c.spaceId === null)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
      .slice(0, limit)
      .map((c) => ({ id: c.id, shared: 0 }));
  }
  return pool
    .map((c) => ({
      c,
      shared: c.memberIds.filter((m) => m !== selfId && people.has(m)).length,
    }))
    .filter((x) => x.shared > 0)
    .sort(
      (a, b) =>
        b.shared - a.shared ||
        // Prefer groups, then things not already organised, then recency.
        (a.c.kind === 'group' ? 0 : 1) - (b.c.kind === 'group' ? 0 : 1) ||
        (a.c.spaceId === null ? 0 : 1) - (b.c.spaceId === null ? 0 : 1) ||
        b.c.lastActivityAt - a.c.lastActivityAt,
    )
    .slice(0, limit)
    .map((x) => ({ id: x.c.id, shared: x.shared }));
}
