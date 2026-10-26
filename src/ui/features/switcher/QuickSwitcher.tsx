import { BellOff, Search, TerminalSquare } from 'lucide-react';
import { useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { formatKeybind, isMacPlatform, resolveKeybinds } from '@/core/commands';
import { initialsFor, type ConversationView } from '@/core/domain';
import {
  HOME,
  isMuted,
  selectConversationViews,
  spacesSelectors,
  uiSelectors,
} from '@/core/stores';
import { conversationFocusTarget, useNow, useSnowdrop } from '@/ui/hooks';
import { ConversationAvatarById } from '@/ui/features/conversation';
import { Badge, Kbd, Modal } from '@/ui/primitives';
import {
  CommandPalette,
  CommandPaletteGroup,
  CommandPaletteInput,
  CommandPaletteItem,
  CommandPaletteList,
  highlight,
} from '@/ui/primitives/CommandPalette';
import {
  parseQuery,
  prefixFor,
  PREFIXES,
  SCOPE_LABELS,
  searchSwitcher,
  type SwitcherItem,
} from './model';
import styles from './QuickSwitcher.module.css';

const PREFIX_HINTS: { prefix: string; label: string }[] = Object.entries(PREFIXES).map(
  ([prefix, scope]) => ({ prefix, label: SCOPE_LABELS[scope as keyof typeof SCOPE_LABELS] }),
);

/**
 * Quick switcher (Ctrl/Cmd+K): fuzzy search over conversations, spaces and
 * commands, with `>` `@` `#` `*` scopes. Built on cmdk for the combobox
 * semantics; ranking and highlighting are ours (`searchSwitcher`).
 */
export function QuickSwitcher({
  onClose,
  initialQuery = '',
}: {
  onClose: () => void;
  /** Starts in a scope, e.g. ">" for commands (the command palette). */
  initialQuery?: string | undefined;
}) {
  const app = useSnowdrop();
  const { stores, commands } = app;
  const byId = useStore(stores.conversations, (s) => s.byId);
  const local = useStore(stores.local, (s) => s.conversations);
  const unread = useStore(stores.conversations, (s) => s.unread);
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const spaceOrder = useStore(stores.spaces, spacesSelectors.orderedIds);
  const current = useStore(stores.ui, uiSelectors.selectedConversation);
  const overrides = useStore(stores.settings, (s) => s.keybinds);
  const allCommands = useSyncExternalStore(
    (fn) => commands.subscribe(fn),
    () => commands.all(),
  );
  const now = useNow();
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState('');
  /** Where focus goes when the switcher closes: the opened conversation, else the opener. */
  const target = useRef<(() => HTMLElement | null) | null>(null);
  const mac = isMacPlatform();

  const { scope } = parseQuery(query);
  const bindings = useMemo(() => resolveKeybinds(allCommands, overrides), [allCommands, overrides]);

  const sections = useMemo(() => {
    const spaceList = spaceOrder.flatMap((id) => {
      const s = spaces[id];
      return s
        ? [
            {
              id: s.id,
              name: s.name,
              hue: s.hue,
              conversationIds: s.categories.flatMap((c) => c.conversationIds),
              ...(s.emoji ? { emoji: s.emoji } : {}),
            },
          ]
        : [];
    });
    const spaceMuted = new Map(spaceList.map((s) => [s.id, spaces[s.id]?.muted ?? false]));
    const mutedSpaceOf = new Map<string, boolean>();
    for (const s of spaceList)
      for (const id of s.conversationIds) mutedSpaceOf.set(id, spaceMuted.get(s.id) ?? false);
    return searchSwitcher(query, {
      views: selectConversationViews(byId, local),
      unread,
      spaces: spaceList,
      commands: allCommands
        .filter((c) => !c.hidden && c.id !== 'core.quickSwitcher' && c.enabled?.() !== false)
        .map((c) => ({
          id: c.id,
          title: c.title,
          ...(c.category ? { category: c.category } : {}),
        })),
      isMuted: (v: ConversationView) => isMuted(v.muted, now) || (mutedSpaceOf.get(v.id) ?? false),
      current,
    });
  }, [query, byId, local, unread, spaces, spaceOrder, allCommands, now, current]);

  const choose = (item: SwitcherItem) => {
    const ui = stores.ui.getState();
    if (item.kind === 'conversation') {
      const space = item.conversationKind === 'group' ? (item.spaceId ?? HOME) : HOME;
      ui.selectConversation(item.id, space);
      // Lands on the message list's current row, unless "Focus the message
      // box when opening a conversation" is on.
      const preferComposer = stores.settings.getState().behaviour.focusComposerOnOpen;
      target.current = () => conversationFocusTarget(item.id, preferComposer);
      onClose();
    } else if (item.kind === 'space') {
      ui.selectSpace(item.id);
      target.current = () =>
        document.querySelector<HTMLElement>(`[data-snowdrop='rail'] [aria-current='page']`);
      onClose();
    } else {
      // Close first: the command may open its own dialog (settings, shortcuts…).
      onClose();
      void commands.execute(item.id);
    }
  };

  const insertPrefix = (prefix: string) => {
    setQuery(`${prefix}${parseQuery(query).text}`);
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Quick switcher"
      hideHeader
      placement="top"
      size="xl"
      flush
      className={styles.modal}
      returnFocus={() => target.current?.() ?? null}
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
          <span className={styles.prefixHints} role="group" aria-label="Search scopes">
            {PREFIX_HINTS.map((h) => (
              <button
                key={h.prefix}
                type="button"
                className={styles.prefix}
                data-active={PREFIXES[h.prefix] === scope ? '' : undefined}
                title={`Type ${h.prefix} to search ${h.label.toLowerCase()}`}
                onClick={() => {
                  insertPrefix(h.prefix);
                  document.querySelector<HTMLInputElement>('[cmdk-input]')?.focus();
                }}
              >
                <kbd>{h.prefix}</kbd>
                {h.label}
              </button>
            ))}
          </span>
        </div>
      }
    >
      <CommandPalette label="Quick switcher" value={active} onValueChange={setActive}>
        <CommandPaletteInput
          data-autofocus
          // Once a prefix becomes the scope chip, the field shows only the search text.
          value={scope === 'all' ? query : parseQuery(query).text}
          onValueChange={(v) => {
            setQuery(scope === 'all' ? v : `${prefixFor(scope)}${v}`);
          }}
          placeholder={
            scope === 'all'
              ? 'Where would you like to go?'
              : `Search ${SCOPE_LABELS[scope].toLowerCase()}`
          }
          leading={
            scope === 'all' ? (
              <Search size={18} aria-hidden />
            ) : (
              <span className={styles.scope}>{SCOPE_LABELS[scope]}</span>
            )
          }
          onKeyDown={(e) => {
            // Backspace on an empty scoped query drops the scope.
            if (e.key === 'Backspace' && scope !== 'all' && parseQuery(query).text === '') {
              e.preventDefault();
              setQuery('');
            }
          }}
        />
        <CommandPaletteList
          label="Results"
          empty={
            sections.every((s) => s.items.length === 0)
              ? parseQuery(query).text
                ? `Nothing matches “${parseQuery(query).text}”.`
                : 'Nothing here yet.'
              : undefined
          }
        >
          {sections.map((section) => (
            <CommandPaletteGroup key={section.id} heading={section.heading}>
              {section.items.map((item) => (
                <CommandPaletteItem
                  key={item.key}
                  value={item.key}
                  onSelect={() => {
                    choose(item);
                  }}
                  icon={<ItemIcon item={item} />}
                  meta={
                    <ItemMeta
                      item={item}
                      combo={item.kind === 'command' ? bindings.get(item.id) : undefined}
                      mac={mac}
                    />
                  }
                >
                  {highlight(item.title, item.indices)}
                </CommandPaletteItem>
              ))}
            </CommandPaletteGroup>
          ))}
        </CommandPaletteList>
      </CommandPalette>
    </Modal>
  );
}

function ItemIcon({ item }: { item: SwitcherItem }) {
  if (item.kind === 'command') return <TerminalSquare size={18} />;
  if (item.kind === 'space')
    return (
      <span
        className={styles.spaceGlyph}
        style={{ '--tile-hue': `var(--snowdrop-avatar-${item.hue})` } as CSSProperties}
      >
        {item.emoji ?? initialsFor(item.title).slice(0, 2)}
      </span>
    );
  return <ConversationAvatarById id={item.id} size={24} />;
}

function ItemMeta({
  item,
  combo,
  mac,
}: {
  item: SwitcherItem;
  combo: Parameters<typeof formatKeybind>[0] | undefined;
  mac: boolean;
}) {
  if (item.kind === 'command') {
    return (
      <>
        {item.category && <span>{item.category}</span>}
        {combo && <Kbd combo={formatKeybind(combo, mac)} />}
      </>
    );
  }
  if (item.kind === 'space') {
    return (
      <>
        <span>Space</span>
        {item.mentions > 0 ? (
          <Badge variant="mention" count={item.mentions} label={`${item.mentions} mentions`} />
        ) : (
          item.unread && <span className={styles.dot} role="img" aria-label="Unread" />
        )}
      </>
    );
  }
  return (
    <>
      {item.muted && <BellOff size={14} aria-label="Muted" />}
      <span>
        {item.conversationKind === 'direct' ? 'Direct message' : (item.spaceName ?? 'Home')}
      </span>
      {item.mentions > 0 ? (
        <Badge variant="mention" count={item.mentions} label={`${item.mentions} mentions`} />
      ) : (
        item.unread > 0 &&
        !item.muted && <span className={styles.dot} role="img" aria-label="Unread" />
      )}
    </>
  );
}
