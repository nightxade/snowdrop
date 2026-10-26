import { Search, SearchX } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import {
  initialsFor,
  formatMessageTimestamp,
  type ConversationId,
  type Message,
} from '@/core/domain';
import {
  contactsSelectors,
  HOME,
  selectConversationViews,
  sessionSelectors,
  spacesSelectors,
  UNKNOWN_CONTACT_NAME,
} from '@/core/stores';
import { conversationFocusTarget, useNow, useSnowdrop } from '@/ui/hooks';
import { ConversationAvatarById, PersonAvatar } from '@/ui/features/conversation';
import { Kbd, Modal, Skeleton, VisuallyHidden } from '@/ui/primitives';
import {
  CommandPalette,
  CommandPaletteGroup,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  highlight,
} from '@/ui/primitives/CommandPalette';
import { searchSwitcher, type SwitcherItem } from '@/ui/features/switcher';
import { queryTerms, resultText, snippetParts } from './model';
import styles from './GlobalSearch.module.css';

const MESSAGE_LIMIT = 50;
const NAME_LIMIT = 5;
const DEBOUNCE_MS = 200;

type MessageSearch =
  | { status: 'idle' }
  | { status: 'searching'; query: string; results: readonly Message[] }
  | { status: 'done'; query: string; results: readonly Message[] };

/**
 * Search across every conversation (Ctrl/Cmd+Shift+F): chats and people by
 * name first, then matching messages from the history stored on this device.
 * Choosing a message opens its conversation and scrolls to it.
 */
export function GlobalSearch({ onClose }: { onClose: () => void }) {
  const { repository, stores } = useSnowdrop();
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const unread = useStore(stores.conversations, (s) => s.unread);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const spaceOrder = useStore(stores.spaces, spacesSelectors.orderedIds);
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const importing = useStore(
    stores.session,
    (s) => sessionSelectors.historyImport(s).status === 'importing',
  );
  const now = useNow();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState('');
  const [search, setSearch] = useState<MessageSearch>({ status: 'idle' });
  const trimmed = query.trim();
  /** Where focus goes when the dialog closes after opening a chat or message. */
  const focusAfterClose = useRef<(() => HTMLElement | null) | null>(null);

  useEffect(() => {
    if (trimmed === '') return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setSearch({ status: 'searching', query: trimmed, results: [] });
      repository
        .search(trimmed, {
          limit: MESSAGE_LIMIT,
          signal: controller.signal,
          onPartial: (results) => {
            if (!controller.signal.aborted)
              setSearch({ status: 'searching', query: trimmed, results });
          },
        })
        .then((results) => {
          if (!controller.signal.aborted) setSearch({ status: 'done', query: trimmed, results });
        })
        .catch(() => {
          // Aborted (a newer query took over) or unreadable storage: show what we have.
          if (!controller.signal.aborted)
            setSearch((s) => ({
              status: 'done',
              query: trimmed,
              results: s.status === 'idle' ? [] : s.results,
            }));
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [trimmed, repository]);

  const names = useMemo(() => {
    if (trimmed === '') return { groups: [], people: [] };
    const spaceList = spaceOrder.flatMap((id) => {
      const s = spaces[id];
      return s
        ? [
            {
              id: s.id,
              name: s.name,
              hue: s.hue,
              conversationIds: s.categories.flatMap((c) => c.conversationIds),
            },
          ]
        : [];
    });
    const base = {
      views: selectConversationViews(byId, local),
      unread,
      spaces: spaceList,
      commands: [],
      isMuted: () => false,
      limit: NAME_LIMIT,
    };
    const pick = (prefix: string) =>
      searchSwitcher(`${prefix}${trimmed}`, base).flatMap((section) => section.items);
    return { groups: pick('#'), people: pick('@') };
  }, [trimmed, byId, local, unread, spaces, spaceOrder]);

  const spaceOf = useMemo(() => {
    const map = new Map<string, string>();
    for (const space of Object.values(spaces))
      for (const c of space.categories) for (const id of c.conversationIds) map.set(id, space.id);
    return map;
  }, [spaces]);

  const spaceFor = (id: ConversationId): string =>
    byId[id]?.kind === 'group' ? (spaceOf.get(id) ?? HOME) : HOME;

  const nameFor = (id: string): string => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME;

  const openConversation = (item: Extract<SwitcherItem, { kind: 'conversation' }>) => {
    stores.ui.getState().selectConversation(item.id, spaceFor(item.id));
    const preferComposer = stores.settings.getState().behaviour.focusComposerOnOpen;
    focusAfterClose.current = () => conversationFocusTarget(item.id, preferComposer);
    onClose();
  };

  const openMessage = (message: Message) => {
    stores.ui
      .getState()
      .requestReveal(
        { conversationId: message.conversationId, messageId: message.id },
        spaceFor(message.conversationId),
      );
    focusAfterClose.current = () => conversationFocusTarget(message.conversationId, false);
    onClose();
  };

  const terms = queryTerms(trimmed);
  const view = trimmed === '' || search.status === 'idle' ? null : search;
  // A newer query's debounce window: show the old results' loading state, not stale text.
  const current = view && view.query === trimmed ? view : null;
  const searching = trimmed !== '' && (current === null || current.status === 'searching');
  const messages = current?.results ?? [];
  const hasNames = names.groups.length + names.people.length > 0;
  const nothing = trimmed !== '' && !searching && !hasNames && messages.length === 0;
  const status =
    trimmed === ''
      ? ''
      : searching
        ? 'Searching messages'
        : `${messages.length === MESSAGE_LIMIT ? `${MESSAGE_LIMIT}+` : messages.length} ${messages.length === 1 ? 'message' : 'messages'} found`;

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Search all chats"
      hideHeader
      placement="top"
      size="xl"
      flush
      returnFocus={() => focusAfterClose.current?.() ?? null}
      footer={
        <div className={styles.hints}>
          <span>
            <Kbd combo="↑" />
            <Kbd combo="↓" /> move
          </span>
          <span>
            <Kbd combo="Enter" /> open
          </span>
          <span>
            <Kbd combo="Esc" /> close
          </span>
        </div>
      }
    >
      <CommandPalette label="Search all chats" value={active} onValueChange={setActive}>
        <CommandPaletteInput
          data-autofocus
          value={query}
          onValueChange={setQuery}
          placeholder="Search chats, people and messages"
          leading={<Search size={18} aria-hidden />}
        />
        {importing && (
          <p className={styles.importHint} role="status">
            Still importing your phone's message history. Results may be incomplete until it
            finishes.
          </p>
        )}
        <CommandPaletteList
          label="Results"
          empty={
            trimmed === '' ? (
              <p className={styles.note}>
                Type to search every conversation. Every word you type must appear in the message.
              </p>
            ) : nothing ? (
              <div className={styles.none}>
                <SearchX size={32} aria-hidden />
                <p>No results for “{trimmed}”.</p>
                <p className={styles.small}>Only history stored on this device is searched.</p>
              </div>
            ) : undefined
          }
        >
          {names.groups.length > 0 && (
            <CommandPaletteGroup heading="Groups">
              {names.groups.map((item) => (
                <NameItem key={item.key} item={item} onChoose={openConversation} />
              ))}
            </CommandPaletteGroup>
          )}
          {names.people.length > 0 && (
            <CommandPaletteGroup heading="People">
              {names.people.map((item) => (
                <NameItem key={item.key} item={item} onChoose={openConversation} />
              ))}
            </CommandPaletteGroup>
          )}
          {messages.length > 0 && (
            <CommandPaletteGroup heading="Messages">
              {messages.map((m) => {
                const author = contacts[m.authorId];
                const name = author?.name ?? UNKNOWN_CONTACT_NAME;
                const conversation = byId[m.conversationId];
                return (
                  <CommandPaletteItem
                    key={m.id}
                    value={`message:${m.id}`}
                    onSelect={() => {
                      openMessage(m);
                    }}
                    icon={
                      <PersonAvatar
                        size={24}
                        contactId={m.authorId}
                        conversationId={m.conversationId}
                        fallback={initialsFor(name)}
                        color={author?.color ?? 'var(--snowdrop-avatar-1)'}
                      />
                    }
                  >
                    <span className={styles.head}>
                      <span className={styles.author}>{name}</span>
                      {conversation && (
                        <span className={styles.where}>
                          {conversation.kind === 'group' ? '#' : '@'}
                          {conversation.title}
                        </span>
                      )}
                      <span className={styles.time}>
                        {formatMessageTimestamp(m.sentAt, now, { clock24h })}
                      </span>
                    </span>
                    <span className={styles.snippet}>
                      {snippetParts(resultText(m, nameFor), terms).map((p, i) =>
                        p.hit ? <mark key={i}>{p.text}</mark> : p.text,
                      )}
                    </span>
                  </CommandPaletteItem>
                );
              })}
            </CommandPaletteGroup>
          )}
          {searching && (
            <div className={styles.loading} aria-hidden>
              {messages.length === 0 && <Skeleton height={44} radius="sm" />}
              <Skeleton height={44} radius="sm" />
            </div>
          )}
        </CommandPaletteList>
        <VisuallyHidden role="status">{status}</VisuallyHidden>
      </CommandPalette>
    </Modal>
  );
}

function NameItem({
  item,
  onChoose,
}: {
  item: SwitcherItem;
  onChoose: (item: Extract<SwitcherItem, { kind: 'conversation' }>) => void;
}) {
  if (item.kind !== 'conversation') return null;
  return (
    <CommandPaletteItem
      value={item.key}
      onSelect={() => {
        onChoose(item);
      }}
      icon={<ConversationAvatarById id={item.id} size={24} />}
    >
      {highlight(item.title, item.indices)}
    </CommandPaletteItem>
  );
}
