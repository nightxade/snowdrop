import { AtSign, Hash } from 'lucide-react';
import { useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { fuzzyFilter, type ConversationId, type ConversationView } from '@/core/domain';
import { HOME, selectConversationViews } from '@/core/stores';
import { conversationFocusTarget, useStores } from '@/ui/hooks';
import { Badge, Kbd, Modal, SearchInput } from '@/ui/primitives';
import styles from './QuickSwitcher.module.css';

const LIMIT = 8;

interface Result {
  view: ConversationView;
  indices: readonly number[];
}

/** Wraps matched characters in <mark> for the result list. */
export function highlight(text: string, indices: readonly number[]): ReactNode[] {
  if (indices.length === 0) return [text];
  const hit = new Set(indices);
  const out: ReactNode[] = [];
  let run = '';
  let runHit = false;
  const flush = (key: number) => {
    if (!run) return;
    out.push(runHit ? <mark key={key}>{run}</mark> : run);
    run = '';
  };
  for (let i = 0; i < text.length; i++) {
    const isHit = hit.has(i);
    if (isHit !== runHit) {
      flush(i);
      runHit = isHit;
    }
    run += text.charAt(i);
  }
  flush(text.length);
  return out;
}

/**
 * Minimal quick switcher: fuzzy search over conversations, arrows + Enter.
 * P4 replaces this with the cmdk palette (spaces, commands, `>`/`@`/`#` prefixes).
 */
export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const stores = useStores();
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const unread = useStore(stores.conversations, (s) => s.unread);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  /** Set when a result is opened: focus goes there instead of back to the opener. */
  const chosen = useRef<ConversationId | null>(null);
  const baseId = useId();
  const listId = `${baseId}-results`;
  const optionId = (id: string) => `${baseId}-${id}`;

  const spaceOf = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const space of Object.values(spaces))
      for (const c of space.categories)
        for (const id of c.conversationIds) map.set(id, { id: space.id, name: space.name });
    return map;
  }, [spaces]);

  const results = useMemo((): Result[] => {
    const views = selectConversationViews(byId, local).filter((v) => !v.archived);
    if (!query.trim()) {
      // Empty query: unread first, then recent.
      const withUnread = views.filter((v) => (unread[v.id]?.count ?? 0) > 0);
      const rest = views.filter((v) => (unread[v.id]?.count ?? 0) === 0);
      return [...withUnread, ...rest].slice(0, LIMIT).map((view) => ({ view, indices: [] }));
    }
    return fuzzyFilter(query, views, (v) => v.title)
      .slice(0, LIMIT)
      .map((r) => ({ view: r.item, indices: r.match.indices }));
  }, [byId, local, unread, query]);

  const open = (view: ConversationView | undefined) => {
    if (!view) return;
    const space = view.kind === 'group' ? (spaceOf.get(view.id)?.id ?? HOME) : HOME;
    chosen.current = view.id;
    stores.ui.getState().selectConversation(view.id, space);
    onClose();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (results.length === 0 ? 0 : (i + delta + results.length) % results.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      open(results[active]?.view);
    }
  };

  const activeResult = results[active];
  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Find a conversation"
      hideHeader
      placement="top"
      size="lg"
      returnFocus={() => (chosen.current ? conversationFocusTarget(chosen.current) : null)}
      footer={
        <div className={styles.hints} aria-hidden>
          <span>
            <Kbd combo="↑" /> <Kbd combo="↓" /> to move
          </span>
          <span>
            <Kbd combo="Enter" /> to open
          </span>
          <span>
            <Kbd combo="Esc" /> to close
          </span>
        </div>
      }
    >
      <div className={styles.body}>
        <SearchInput
          value={query}
          onValueChange={(v) => {
            setQuery(v);
            setActive(0);
          }}
          placeholder="Where would you like to go?"
          aria-label="Search conversations"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeResult ? optionId(activeResult.view.id) : undefined}
          onKeyDown={onKeyDown}
        />
        <p className={styles.caption}>{query ? 'Results' : 'Unread and recent'}</p>
        <ul id={listId} role="listbox" className={styles.list} aria-label="Conversations">
          {results.length === 0 && (
            <li className={styles.none} role="presentation">
              No conversations match “{query}”.
            </li>
          )}
          {results.map(({ view, indices }, i) => {
            const Glyph = view.kind === 'group' ? Hash : AtSign;
            const where = spaceOf.get(view.id)?.name;
            return (
              <li
                key={view.id}
                id={optionId(view.id)}
                role="option"
                aria-selected={i === active}
                className={styles.option}
                onMouseMove={() => {
                  setActive(i);
                }}
                onClick={() => {
                  open(view);
                }}
              >
                <Glyph size={16} className={styles.glyph} aria-hidden />
                <span className={styles.title}>{highlight(view.title, indices)}</span>
                {where && <span className={styles.where}>{where}</span>}
                <Badge variant="mention" count={unread[view.id]?.mentions ?? 0} />
              </li>
            );
          })}
        </ul>
      </div>
    </Modal>
  );
}
