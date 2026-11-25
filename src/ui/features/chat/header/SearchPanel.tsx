import { SearchX, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { ConversationView, Message } from '@/core/domain';
import { contactsSelectors, sessionSelectors, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useHandOffRow, useSnowdrop } from '@/ui/hooks';
import { IconButton, SearchInput, Skeleton } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { chatSignature } from './chatSignature';
import { MessageResult } from './MessageResult';
import styles from './SearchPanel.module.css';

const LIMIT = 50;
const DEBOUNCE_MS = 200;

/** What a panel that has just mounted is told about its arrival (see `SearchPanel`'s `onArrive`). */
export interface PanelArrival {
  /** The user opened the search, as opposed to the panel moving between the page and a sheet. */
  opened: boolean;
  /** What had focus in the panel that went, when it was this panel's own. */
  held: PanelFocus | null;
}

export type PanelFocus = { kind: 'field' } | { kind: 'close' } | { kind: 'result'; id: string };

const NO_IDS: readonly string[] = [];

type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'done'; query: string; results: Message[] };

/** Ctrl+F: search this conversation's local history; click a result to jump to it. */
export function SearchPanel({
  conversation,
  query,
  onQueryChange,
  onClose,
  onReveal,
  onArrive,
}: {
  conversation: ConversationView;
  /** What is typed in the field: kept by the owner, so it survives the panel moving between page and sheet. */
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  /** A result was opened (Enter, a click): the owner jumps to the message; the default does so itself. */
  onReveal?: (messageId: Message['id']) => void;
  /**
   * The panel has mounted: the owner says what this is, a search the user just opened (focus goes
   * to the field), or the panel moved between the page and a sheet (focus stays where it was, or
   * goes to the same element here when it was in the panel).
   */
  onArrive?: () => PanelArrival;
}) {
  const { repository, stores } = useSnowdrop();
  const importing = useStore(
    stores.session,
    (s) => sessionSelectors.historyImport(s).status === 'importing',
  );
  const chat = useChatController();
  const reveal = (id: Message['id']) => {
    if (onReveal) onReveal(id);
    else void chat.reveal(conversation.id, id, { focus: true });
  };
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const trimmed = query.trim();

  /** The result that had focus before the panel moved: focused again once the results are back. */
  const heldResult = useRef<string | null>(null);
  const arrive = useRef(onArrive);
  useEffect(() => {
    const arrival = arrive.current?.() ?? { opened: true, held: null };
    if (arrival.opened) {
      input.current?.focus();
      return;
    }
    const root = input.current?.closest('[data-snowdrop="search-panel"]');
    const held = arrival.held;
    if (!root || held === null || document.activeElement !== document.body) return;
    const same =
      held.kind === 'close'
        ? root.querySelector<HTMLElement>('[aria-label^="Close search"]')
        : input.current;
    same?.focus();
    if (held.kind === 'result') heldResult.current = held.id;
  }, []);

  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const names = useRef(contacts);
  useEffect(() => {
    names.current = contacts;
  });
  const nameFor = useMemo(
    () => (id: string) => names.current[id]?.name ?? UNKNOWN_CONTACT_NAME,
    [],
  );

  // What decides the results: which messages there are, whether each is deleted, and its edit
  // count. A new message, a delete, an expiry or an edit changes it and the results follow (they
  // are searched again, quietly); a receipt, a status or a reaction does not.
  const messages = useStore(stores.messages, (s) => chatSignature(s, conversation.id));
  /** The query the results on screen were found for. */
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (trimmed === '') {
      shown.current = null;
      return;
    }
    let cancelled = false;
    const refresh = shown.current === trimmed;
    const timer = setTimeout(() => {
      if (!refresh) setState({ status: 'searching', query: trimmed });
      repository
        .search(trimmed, { conversationId: conversation.id, limit: LIMIT, nameFor })
        .then((results) => {
          if (cancelled) return;
          shown.current = trimmed;
          setState({ status: 'done', query: trimmed, results });
        })
        .catch(() => {
          if (cancelled || refresh) return;
          shown.current = trimmed;
          setState({ status: 'done', query: trimmed, results: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, repository, conversation.id, messages, nameFor]);

  // Results (and "no match") belong to the query they were found for. While the field has moved
  // on, old results stay up until the new ones land, but an old "no match" is no answer to the
  // new text; and Enter only ever opens a match for what is typed now.
  const current = state.status === 'done' && state.query === trimmed;
  const view: SearchState =
    trimmed === ''
      ? { status: 'idle' }
      : state.status === 'done' && !current && state.results.length === 0
        ? { status: 'searching', query: trimmed }
        : state;

  // A result with focus that leaves the list (deleted for everyone, an edit that no longer matches)
  // hands focus to the next result, else the previous, else the field: never the page (M15).
  const shownIds = view.status === 'done' ? view.results.map((m) => m.id) : NO_IDS;
  useHandOffRow({
    ids: shownIds,
    scope: conversation.id,
    identify: (el) =>
      el
        .closest('[data-snowdrop="search-panel"] [data-search-result]')
        ?.getAttribute('data-result-id') ?? null,
    find: (id) => list.current?.querySelector<HTMLElement>(`[data-result-id="${CSS.escape(id)}"]`),
    tabStop: () => input.current,
  });
  useEffect(() => {
    const id = heldResult.current;
    if (id === null || view.status !== 'done') return;
    heldResult.current = null;
    list.current?.querySelector<HTMLElement>(`[data-result-id="${CSS.escape(id)}"]`)?.focus();
  });

  return (
    <aside
      className={styles.panel}
      aria-label={`Search ${conversation.title}`}
      data-snowdrop="search-panel"
      data-pane-title="search"
      // Esc is this panel's (it closes it): Vim's Esc, and a narrow sheet's own, leave it alone.
      data-owns-escape=""
      // Esc closes the panel from anywhere in it, with text in the field too (which would clear
      // it first) and on a result.
      onKeyDownCapture={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }}
      onKeyDown={(e) => {
        // ↓ from the field into the results, ↑/↓ between them, ↑ from the first back to the field.
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const results = [
          ...(list.current?.querySelectorAll<HTMLElement>('[data-search-result]') ?? []),
        ];
        if (results.length === 0) return;
        const i = results.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        if (e.key === 'ArrowDown') results[Math.min(results.length - 1, i + 1)]?.focus();
        else if (i <= 0) input.current?.focus();
        else results[i - 1]?.focus();
      }}
    >
      <header className={styles.header}>
        <SearchInput
          ref={input}
          value={query}
          onValueChange={onQueryChange}
          placeholder={`Search ${conversation.kind === 'group' ? '#' : '@'}${conversation.title}`}
          aria-label="Search messages"
          onKeyDown={(e) => {
            // Enter opens the best (newest) match.
            if (e.key === 'Enter' && state.status === 'done' && current && state.results[0]) {
              e.preventDefault();
              reveal(state.results[0].id);
            }
          }}
        />
        <IconButton label="Close search (Esc)" icon={<X />} onClick={onClose} />
      </header>
      {importing && (
        <p className={styles.importHint} role="status">
          Still importing your phone's message history — results may be incomplete until it
          finishes.
        </p>
      )}
      <div className={styles.results}>
        {view.status === 'idle' && (
          <p className={styles.empty}>
            Find messages in this conversation. Every word you type must appear in the message.
          </p>
        )}
        {view.status === 'searching' && (
          <div className={styles.loading} aria-busy="true">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={64} radius="sm" />
            ))}
          </div>
        )}
        {view.status === 'done' && view.results.length === 0 && (
          <div className={styles.none}>
            <SearchX size={32} aria-hidden />
            <p>No messages match “{view.query}”.</p>
            <p className={styles.small}>Only history stored on this device is searched.</p>
          </div>
        )}
        {view.status === 'done' && view.results.length > 0 && (
          <>
            <p className={styles.count} role="status">
              {view.results.length === LIMIT ? `${LIMIT}+` : view.results.length}{' '}
              {view.results.length === 1 ? 'result' : 'results'}
            </p>
            <ul className={styles.list} ref={list} aria-busy={!current}>
              {view.results.map((m) => (
                <li key={m.id}>
                  <MessageResult
                    message={m}
                    onOpen={() => {
                      reveal(m.id);
                    }}
                  />
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}
