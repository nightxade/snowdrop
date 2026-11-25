/**
 * Quick switcher search model (PLAN §4.8), pure so ranking is unit-tested.
 *
 * Prefixes narrow the scope: `>` commands, `@` direct messages, `#` groups,
 * `*` spaces. Without a prefix everything is searched; commands rank a little
 * below places, since most switcher use is navigation.
 */
import { fuzzyMatch, type ConversationId, type ConversationView } from '@/core/domain';
import { attentionOf, type UnreadState } from '@/core/stores';

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
      /** Shown when searching only; the empty-query lists leave archived chats out. */
      archived: boolean;
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
    archived: view.archived,
    indices,
  };
}

function spaceItem(
  space: SwitcherSpace,
  input: SwitcherInput,
  indices: readonly number[] = [],
): Extract<SwitcherItem, { kind: 'space' }> {
  // The same rule as the rail's dot and the sidebar's badges (`attentionOf`):
  // archived chats count for nothing, and `isMuted` already folds in a muted space.
  const viewOf = new Map(input.views.map((v) => [v.id, v]));
  let mentions = 0;
  let unread = false;
  for (const id of space.conversationIds) {
    const view = viewOf.get(id);
    if (!view || view.archived) continue;
    const one = attentionOf(input.unread[id], input.isMuted(view), view.markedUnread === true);
    mentions += one.mentions;
    if (one.hasUnread) unread = true;
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

interface Scored {
  item: SwitcherItem;
  score: number;
  order: number;
}

/** The conversations whose title matches `text`, each with its score (unread nudges included). */
function scoreConversations(
  text: string,
  views: readonly ConversationView[],
  input: SwitcherInput,
  spaceOf: Map<string, SwitcherSpace>,
): { item: Extract<SwitcherItem, { kind: 'conversation' }>; score: number }[] {
  const out: { item: Extract<SwitcherItem, { kind: 'conversation' }>; score: number }[] = [];
  for (const view of views) {
    const m = fuzzyMatch(text, view.title);
    if (!m) continue;
    const u = input.unread[view.id];
    // Small nudges only: a better text match always wins over unread state.
    const bonus = Math.min(MAX_UNREAD_BONUS, (u?.mentions ? 2 : 0) + (u?.count ? 1 : 0));
    out.push({ item: conversationItem(view, input, spaceOf, m.indices), score: m.score + bonus });
  }
  return out;
}

/**
 * Chats of one kind whose title matches `text`, best first (archived ones
 * after live ones of equal score): what the `#` (groups) and `@` (people)
 * scopes show, without going through the query syntax. Nothing is returned for empty text.
 */
export function searchConversations(
  text: string,
  kind: 'direct' | 'group',
  input: SwitcherInput,
): Extract<SwitcherItem, { kind: 'conversation' }>[] {
  const needle = text.trim();
  if (!needle) return [];
  const spaceOf = new Map<string, SwitcherSpace>();
  for (const space of input.spaces) for (const id of space.conversationIds) spaceOf.set(id, space);
  // Archived chats are findable, after live ones of equal score (as in the quick switcher).
  const views = input.views.filter((v) => v.kind === kind);
  const scored = scoreConversations(needle, views, input, spaceOf).map((entry, order) => ({
    ...entry,
    order,
  }));
  const archived = (s: { item: SwitcherItem }) =>
    s.item.kind === 'conversation' && s.item.archived ? 1 : 0;
  scored.sort((a, b) => b.score - a.score || archived(a) - archived(b) || a.order - b.order);
  const best = scored[0]?.score ?? 0;
  return scored
    .filter((s) => best <= 0 || s.score >= best * RELATIVE_FLOOR)
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map((s) => s.item);
}

/** Results for a raw query, already grouped for display. */
export function searchSwitcher(raw: string, input: SwitcherInput): SwitcherSection[] {
  const { scope, text } = parseQuery(raw);
  const limit = input.limit ?? DEFAULT_LIMIT;
  const spaceOf = new Map<string, SwitcherSpace>();
  for (const space of input.spaces) for (const id of space.conversationIds) spaceOf.set(id, space);
  const inScope = input.views.filter(
    (v) =>
      scope === 'all' ||
      (scope === 'direct' && v.kind === 'direct') ||
      (scope === 'groups' && v.kind === 'group'),
  );
  // Searching finds archived chats too (they rank below live ones of equal score);
  // the browsing lists for an empty query leave them out.
  const views = inScope.filter((v) => text !== '' || !v.archived);
  const wantsConversations = scope === 'all' || scope === 'direct' || scope === 'groups';
  const wantsSpaces = scope === 'all' || scope === 'spaces';
  const wantsCommands = scope === 'all' || scope === 'commands';

  if (!text) return emptyQuery(scope, views, input, spaceOf, limit);

  const scored: Scored[] = [];
  let order = 0;
  if (wantsConversations) {
    for (const entry of scoreConversations(text, views, input, spaceOf)) {
      scored.push({ ...entry, order: order++ });
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
  const isArchived = (s: Scored) => (s.item.kind === 'conversation' && s.item.archived ? 1 : 0);
  scored.sort((a, b) => b.score - a.score || isArchived(a) - isArchived(b) || a.order - b.order);
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
