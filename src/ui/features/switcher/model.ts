/**
 * Quick switcher search model (PLAN §4.8), pure so ranking is unit-tested.
 *
 * Prefixes narrow the scope: `>` commands, `@` direct messages, `#` groups,
 * `*` spaces. Without a prefix everything is searched; commands rank a little
 * below places, since most switcher use is navigation.
 */
import { fuzzyMatch, type ConversationId, type ConversationView } from '@/core/domain';
import type { UnreadState } from '@/core/stores';

export type SwitcherScope = 'all' | 'commands' | 'direct' | 'groups' | 'spaces';

export const PREFIXES: Readonly<Record<string, SwitcherScope>> = {
  '>': 'commands',
  '@': 'direct',
  '#': 'groups',
  '*': 'spaces',
};

export const SCOPE_LABELS: Record<Exclude<SwitcherScope, 'all'>, string> = {
  commands: 'Commands',
  direct: 'People',
  groups: 'Groups',
  spaces: 'Spaces',
};

/** The prefix character for a scope (inverse of PREFIXES). */
export function prefixFor(scope: SwitcherScope): string {
  return Object.entries(PREFIXES).find(([, sc]) => sc === scope)?.[0] ?? '';
}

export function parseQuery(raw: string): { scope: SwitcherScope; text: string } {
  const trimmed = raw.trimStart();
  const scope = PREFIXES[trimmed.charAt(0)];
  return scope ? { scope, text: trimmed.slice(1).trim() } : { scope: 'all', text: raw.trim() };
}

export type SwitcherItem =
  | {
      kind: 'conversation';
      key: string;
      id: ConversationId;
      conversationKind: 'direct' | 'group';
      title: string;
      /** Space the conversation lives in (groups only). */
      spaceId: string | null;
      spaceName: string | null;
      unread: number;
      mentions: number;
      muted: boolean;
      indices: readonly number[];
    }
  | {
      kind: 'space';
      key: string;
      id: string;
      title: string;
      emoji: string | null;
      hue: number;
      unread: boolean;
      mentions: number;
      indices: readonly number[];
    }
  | {
      kind: 'command';
      key: string;
      id: string;
      title: string;
      category: string | null;
      indices: readonly number[];
    };

export interface SwitcherSpace {
  id: string;
  name: string;
  emoji?: string;
  hue: number;
  conversationIds: readonly ConversationId[];
}

export interface SwitcherCommand {
  id: string;
  title: string;
  category?: string;
}

export interface SwitcherInput {
  views: readonly ConversationView[];
  unread: Readonly<Record<string, UnreadState | undefined>>;
  spaces: readonly SwitcherSpace[];
  commands: readonly SwitcherCommand[];
  isMuted: (view: ConversationView) => boolean;
  /** Currently open conversation, left out of the "recent" list (you're already there). */
  current?: ConversationId | null;
  limit?: number;
}

export interface SwitcherSection {
  id: string;
  heading: string;
  items: SwitcherItem[];
}

/** Commands rank a little below places when unscoped; less so when they match a word start. */
const COMMAND_PENALTY = 6;
const COMMAND_PENALTY_WORD_START = 2;
/** Unread/mention nudges can only reorder results whose text scores are this close. */
const MAX_UNREAD_BONUS = 2;
/** Weak tail matches below this fraction of the best score are dropped. */
const RELATIVE_FLOOR = 0.4;

/** Does the match start at the beginning of a word (or of the title)? */
function startsAtWord(title: string, indices: readonly number[]): boolean {
  const first = indices[0];
  if (first === undefined) return false;
  return first === 0 || /[\s\-_./#@:·]/u.test(title.charAt(first - 1));
}
const DEFAULT_LIMIT = 30;

function conversationItem(
  view: ConversationView,
  input: SwitcherInput,
  spaceOf: Map<string, SwitcherSpace>,
  indices: readonly number[] = [],
): Extract<SwitcherItem, { kind: 'conversation' }> {
  const space = view.kind === 'group' ? spaceOf.get(view.id) : undefined;
  const u = input.unread[view.id];
  return {
    kind: 'conversation',
    key: `conversation:${view.id}`,
    id: view.id,
    conversationKind: view.kind,
    title: view.title,
    spaceId: space?.id ?? null,
    spaceName: space?.name ?? null,
    unread: u?.count ?? 0,
    mentions: u?.mentions ?? 0,
    muted: input.isMuted(view),
    indices,
  };
}

function spaceItem(
  space: SwitcherSpace,
  input: SwitcherInput,
  indices: readonly number[] = [],
): Extract<SwitcherItem, { kind: 'space' }> {
  let mentions = 0;
  let unread = false;
  for (const id of space.conversationIds) {
    const u = input.unread[id];
    if (!u) continue;
    mentions += u.mentions;
    if (u.count > 0) unread = true;
  }
  return {
    kind: 'space',
    key: `space:${space.id}`,
    id: space.id,
    title: space.name,
    emoji: space.emoji ?? null,
    hue: space.hue,
    unread,
    mentions,
    indices,
  };
}

function commandItem(
  command: SwitcherCommand,
  indices: readonly number[] = [],
): Extract<SwitcherItem, { kind: 'command' }> {
  return {
    kind: 'command',
    key: `command:${command.id}`,
    id: command.id,
    title: command.title,
    category: command.category ?? null,
    indices,
  };
}

/** Results for a raw query, already grouped for display. */
export function searchSwitcher(raw: string, input: SwitcherInput): SwitcherSection[] {
  const { scope, text } = parseQuery(raw);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const spaceOf = new Map<string, SwitcherSpace>();
  for (const space of input.spaces) for (const id of space.conversationIds) spaceOf.set(id, space);
  const views = input.views.filter(
    (v) =>
      !v.archived &&
      (scope === 'all' ||
        (scope === 'direct' && v.kind === 'direct') ||
        (scope === 'groups' && v.kind === 'group')),
  );
  const wantsConversations = scope === 'all' || scope === 'direct' || scope === 'groups';
  const wantsSpaces = scope === 'all' || scope === 'spaces';
  const wantsCommands = scope === 'all' || scope === 'commands';

  if (!text) return emptyQuery(scope, views, input, spaceOf, limit);

  const scored: { item: SwitcherItem; score: number; order: number }[] = [];
  let order = 0;
  if (wantsConversations) {
    for (const view of views) {
      const m = fuzzyMatch(text, view.title);
      if (!m) continue;
      const u = input.unread[view.id];
      // Small nudges only: a better text match always wins over unread state.
      const bonus = Math.min(MAX_UNREAD_BONUS, (u?.mentions ? 2 : 0) + (u?.count ? 1 : 0));
      scored.push({
        item: conversationItem(view, input, spaceOf, m.indices),
        score: m.score + bonus,
        order: order++,
      });
    }
  }
  if (wantsSpaces) {
    for (const space of input.spaces) {
      const m = fuzzyMatch(text, space.name);
      if (m)
        scored.push({ item: spaceItem(space, input, m.indices), score: m.score, order: order++ });
    }
  }
  if (wantsCommands) {
    for (const command of input.commands) {
      const m = fuzzyMatch(text, command.title);
      if (!m) continue;
      scored.push({
        item: commandItem(command, m.indices),
        score:
          m.score -
          (scope !== 'all'
            ? 0
            : startsAtWord(command.title, m.indices)
              ? COMMAND_PENALTY_WORD_START
              : COMMAND_PENALTY),
        order: order++,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  const best = scored[0]?.score ?? 0;
  const items = scored
    .filter((s) => best <= 0 || s.score >= best * RELATIVE_FLOOR)
    .slice(0, limit)
    .map((s) => s.item);
  return items.length > 0 ? [{ id: 'results', heading: 'Best matches', items }] : [];
}

function emptyQuery(
  scope: SwitcherScope,
  views: readonly ConversationView[],
  input: SwitcherInput,
  spaceOf: Map<string, SwitcherSpace>,
  limit: number,
): SwitcherSection[] {
  if (scope === 'commands') {
    // Browsing: one group per category, alphabetical.
    const byCategory = new Map<string, SwitcherItem[]>();
    for (const c of [...input.commands].sort((a, b) => a.title.localeCompare(b.title))) {
      const key = c.category ?? 'Other';
      byCategory.set(key, [...(byCategory.get(key) ?? []), commandItem(c)]);
    }
    return [...byCategory]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, items]) => ({ id: `commands:${category}`, heading: category, items }));
  }
  if (scope === 'spaces') {
    return [
      { id: 'spaces', heading: 'Spaces', items: input.spaces.map((s) => spaceItem(s, input)) },
    ];
  }
  // Unread first (mentions, then most recent), then recent activity.
  const attention = views
    .filter((v) => {
      const u = input.unread[v.id];
      return (u?.mentions ?? 0) > 0 || ((u?.count ?? 0) > 0 && !input.isMuted(v));
    })
    .sort(
      (a, b) =>
        (input.unread[b.id]?.mentions ?? 0) - (input.unread[a.id]?.mentions ?? 0) ||
        b.lastActivityAt - a.lastActivityAt,
    );
  const taken = new Set(attention.map((v) => v.id));
  const recent = views.filter((v) => !taken.has(v.id) && v.id !== input.current);
  const sections: SwitcherSection[] = [];
  const unreadItems = attention.slice(0, limit).map((v) => conversationItem(v, input, spaceOf));
  if (unreadItems.length > 0)
    sections.push({ id: 'unread', heading: 'Unread', items: unreadItems });
  const room = Math.max(0, Math.min(8, limit - unreadItems.length));
  const recentItems = recent.slice(0, room).map((v) => conversationItem(v, input, spaceOf));
  if (recentItems.length > 0)
    sections.push({ id: 'recent', heading: 'Recent', items: recentItems });
  return sections;
}
