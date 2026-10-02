import { Sparkles, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FocusEvent } from 'react';
import { useStore } from 'zustand';
import { fuzzyFilter, type ConversationId } from '@/core/domain';
import {
  DEFAULT_LOCAL_CONVERSATION,
  selectConversationViews,
  sessionSelectors,
} from '@/core/stores';
import { ConversationAvatar } from '@/ui/features/conversation';
import { useStores } from '@/ui/hooks';
import { Checkbox, SearchInput } from '@/ui/primitives';
import { suggestConversations } from './suggest';
import styles from './ConversationChecklist.module.css';

export interface ConversationChecklistProps {
  selected: ReadonlySet<ConversationId>;
  onChange: (next: Set<ConversationId>) => void;
  /** The space being edited (its own conversations aren't "in another space"). */
  spaceId?: string;
}

/**
 * Searchable checklist of groups and DMs for a space, with suggestions that
 * share members with the current picks.
 */
export function ConversationChecklist({ selected, onChange, spaceId }: ConversationChecklistProps) {
  const stores = useStores();
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const [query, setQuery] = useState('');

  const spaceOf = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const s of Object.values(spaces))
      for (const c of s.categories)
        for (const id of c.conversationIds) map.set(id, { id: s.id, name: s.name });
    return map;
  }, [spaces]);

  const views = useMemo(
    () =>
      selectConversationViews(byId, local)
        .filter((v) => !v.archived)
        // Groups first: spaces are mostly for groups.
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'group' ? -1 : 1)),
    [byId, local],
  );
  const otherSpace = (id: string) => {
    const s = spaceOf.get(id);
    return s && s.id !== spaceId ? s : null;
  };

  const suggestions = useMemo(
    () =>
      suggestConversations(
        views.map((v) => {
          const s = spaceOf.get(v.id);
          return {
            id: v.id,
            kind: v.kind,
            memberIds: v.memberIds,
            lastActivityAt: v.lastActivityAt,
            spaceId: s && s.id !== spaceId ? s.id : null,
          };
        }),
        selected,
        selfId,
      ),
    [views, selected, selfId, spaceOf, spaceId],
  );

  const filtered = query.trim()
    ? fuzzyFilter(query, views, (v) => v.title).map((r) => r.item)
    : views;

  const toggle = (id: ConversationId, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    onChange(next);
  };

  const row = (id: ConversationId, hint?: string) => {
    const conversation = byId[id];
    if (!conversation) return null;
    const view = { ...conversation, ...(local[id] ?? DEFAULT_LOCAL_CONVERSATION) };
    const elsewhere = otherSpace(id);
    const meta = [
      hint,
      view.kind === 'group' ? `${view.memberIds.length} members` : 'Direct message',
      elsewhere ? `moves from ${elsewhere.name}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    return (
      <li key={id}>
        <Checkbox
          className={styles.row}
          checked={selected.has(id)}
          onCheckedChange={(on) => {
            toggle(id, on);
          }}
        >
          <ConversationAvatar conversation={view} size={24} />
          <span className={styles.text}>
            <span className={styles.title}>{view.title}</span>
            <span className={styles.meta}>{meta}</span>
          </span>
        </Checkbox>
      </li>
    );
  };

  // Suggestions re-rank as you pick. While the pointer is over the list (or
  // focus is in it) they're frozen, and they refresh after 300 ms of pointer
  // stillness, so rows never jump out from under a click or a key press.
  const [frozen, setFrozen] = useState<typeof suggestions | null>(null);
  const holds = useRef({ pointer: false, focus: false });
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const display = frozen ?? suggestions;
  const freeze = () => {
    setFrozen((f) => f ?? display);
  };
  const release = () => {
    if (!holds.current.pointer && !holds.current.focus) setFrozen(null);
  };
  useEffect(
    () => () => {
      if (idle.current) clearTimeout(idle.current);
    },
    [],
  );
  const listHandlers = {
    onPointerMove: () => {
      holds.current.pointer = true;
      freeze();
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(() => {
        holds.current.pointer = false;
        release();
      }, 300);
    },
    onPointerLeave: () => {
      holds.current.pointer = false;
      if (idle.current) clearTimeout(idle.current);
      release();
    },
    onFocus: (e: FocusEvent<HTMLDivElement>) => {
      // Keyboard focus holds the list still; a mouse click is covered by the pointer rule.
      if (!(e.target instanceof HTMLElement) || !e.target.matches(':focus-visible')) return;
      holds.current.focus = true;
      freeze();
    },
    onBlur: (e: FocusEvent<HTMLDivElement>) => {
      if (e.currentTarget.contains(e.relatedTarget)) return;
      holds.current.focus = false;
      release();
    },
  };

  const picked = [...selected].filter((id) => byId[id]);
  const showSuggestions = !query.trim() && display.length > 0;

  return (
    <div className={styles.root}>
      <div className={styles.head}>
        <span className={styles.label}>Conversations</span>
        <span className={styles.count} aria-live="polite">
          {selected.size} selected
        </span>
      </div>
      <SearchInput
        size="sm"
        value={query}
        onValueChange={setQuery}
        placeholder="Search groups and people"
        aria-label="Search conversations to add"
      />
      {picked.length > 0 && (
        <ul className={styles.chips} aria-label="Picked conversations">
          {picked.map((id) => (
            <li key={id} className={styles.chip}>
              <span className={styles.chipText}>{byId[id]?.title}</span>
              <button
                type="button"
                className={styles.chipRemove}
                aria-label={`Remove ${byId[id]?.title ?? 'conversation'}`}
                onClick={() => {
                  toggle(id, false);
                }}
              >
                <X size={12} aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className={styles.list} {...listHandlers}>
        {showSuggestions && (
          <section aria-label="Suggested">
            <p className={styles.section}>
              <Sparkles size={12} aria-hidden />
              {selected.size > 0 ? 'Shares people with your picks' : 'Recent groups'}
            </p>
            <ul>
              {display.map((s) => row(s.id, s.shared > 0 ? `${s.shared} in common` : undefined))}
            </ul>
          </section>
        )}
        <section aria-label={query.trim() ? 'Results' : 'All conversations'}>
          {showSuggestions && <p className={styles.section}>All conversations</p>}
          <ul>
            {filtered.map((v) => row(v.id))}
            {filtered.length === 0 && <li className={styles.none}>Nothing matches “{query}”.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}
