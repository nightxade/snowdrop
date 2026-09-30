import { AtSign, Hash } from 'lucide-react';
import { useMemo, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { fuzzyFilter, type ConversationView } from '@/core/domain';
import { HOME, selectConversationViews } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { Badge, Modal, SearchInput } from '@/ui/primitives';
import styles from './QuickSwitcher.module.css';

const LIMIT = 8;

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

  const spaceOf = useMemo(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const space of Object.values(spaces))
      for (const c of space.categories)
        for (const id of c.conversationIds) map.set(id, { id: space.id, name: space.name });
    return map;
  }, [spaces]);

  const results = useMemo(() => {
    const views = selectConversationViews(byId, local).filter((v) => !v.archived);
    if (!query.trim()) {
      // Empty query: unread first, then recent.
      const withUnread = views.filter((v) => (unread[v.id]?.count ?? 0) > 0);
      const rest = views.filter((v) => (unread[v.id]?.count ?? 0) === 0);
      return [...withUnread, ...rest].slice(0, LIMIT);
    }
    return fuzzyFilter(query, views, (v) => v.title)
      .slice(0, LIMIT)
      .map((r) => r.item);
  }, [byId, local, unread, query]);

  const open = (view: ConversationView | undefined) => {
    if (!view) return;
    const space = view.kind === 'group' ? (spaceOf.get(view.id)?.id ?? HOME) : HOME;
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
      open(results[active]);
    }
  };

  const listId = 'quick-switcher-results';
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
          aria-activedescendant={results[active] ? `qs-${results[active].id}` : undefined}
          autoFocus
          onKeyDown={onKeyDown}
        />
        <p className={styles.caption}>{query ? 'Results' : 'Unread and recent'}</p>
        <ul id={listId} role="listbox" className={styles.list} aria-label="Conversations">
          {results.length === 0 && (
            <li className={styles.none}>No conversations match “{query}”.</li>
          )}
          {results.map((view, i) => {
            const Glyph = view.kind === 'group' ? Hash : AtSign;
            const where = spaceOf.get(view.id)?.name;
            return (
              <li
                key={view.id}
                id={`qs-${view.id}`}
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
                <span className={styles.title}>{view.title}</span>
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
