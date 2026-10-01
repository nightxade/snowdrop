import { SearchX, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ConversationView, Message } from '@/core/domain';
import { useShrike } from '@/ui/hooks';
import { IconButton, SearchInput, Skeleton } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { MessageResult } from './MessageResult';
import styles from './SearchPanel.module.css';

const LIMIT = 50;
const DEBOUNCE_MS = 200;

type SearchState =
  | { status: 'idle' }
  | { status: 'searching'; query: string }
  | { status: 'done'; query: string; results: Message[] };

/** Ctrl+F: search this conversation's local history; click a result to jump to it. */
export function SearchPanel({
  conversation,
  onClose,
}: {
  conversation: ConversationView;
  onClose: () => void;
}) {
  const { repository } = useShrike();
  const chat = useChatController();
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ status: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const trimmed = query.trim();

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    if (trimmed === '') return;
    let cancelled = false;
    const timer = setTimeout(() => {
      setState({ status: 'searching', query: trimmed });
      repository
        .search(trimmed, { conversationId: conversation.id, limit: LIMIT })
        .then((results) => {
          if (!cancelled) setState({ status: 'done', query: trimmed, results });
        })
        .catch(() => {
          if (!cancelled) setState({ status: 'done', query: trimmed, results: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, repository, conversation.id]);

  const view: SearchState = trimmed === '' ? { status: 'idle' } : state;

  return (
    <aside
      className={styles.panel}
      aria-label={`Search ${conversation.title}`}
      data-shrike="search-panel"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className={styles.header}>
        <SearchInput
          ref={input}
          value={query}
          onValueChange={setQuery}
          placeholder={`Search ${conversation.kind === 'group' ? '#' : '@'}${conversation.title}`}
          aria-label="Search messages"
        />
        <IconButton label="Close search (Esc)" icon={<X />} onClick={onClose} />
      </header>
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
            <ul className={styles.list}>
              {view.results.map((m) => (
                <li key={m.id}>
                  <MessageResult
                    message={m}
                    onOpen={() => {
                      void chat.reveal(conversation.id, m.id);
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
