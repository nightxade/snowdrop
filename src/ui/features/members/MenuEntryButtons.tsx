import { Check, ChevronDown } from 'lucide-react';
import { Button, DropdownMenu, tidyMenu, type MenuEntry } from '@/ui/primitives';
import styles from './ProfilePopout.module.css';

/** The entry with every `onSelect` (submenus included) also running `after`. */
function thenDo(entry: MenuEntry, after: () => void): MenuEntry {
  if (entry.kind === 'submenu') {
    return { ...entry, items: entry.items.map((item) => thenDo(item, after)) };
  }
  if (entry.kind === 'item' || entry.kind === 'check') {
    return {
      ...entry,
      onSelect: () => {
        entry.onSelect();
        after();
      },
    };
  }
  return entry;
}

/**
 * Menu entries laid out as buttons (the profile card's "More actions"): every
 * kind the menus render is carried over, so an item looks and behaves the same
 * here as in a context menu: disabled items are inert, a check shows its
 * state, a submenu opens its own menu, and a label or separator groups them.
 * `onDone` runs after any item is chosen (the card closes).
 */
export function MenuEntryButtons({
  entries,
  onDone,
}: {
  entries: readonly MenuEntry[];
  onDone: () => void;
}) {
  return tidyMenu(entries.map((entry) => thenDo(entry, onDone))).map((entry) => {
    switch (entry.kind) {
      case 'separator':
        return <span key={entry.id} role="separator" className={styles.pluginSeparator} />;
      case 'label':
        return (
          <span key={entry.id} className={styles.pluginLabel}>
            {entry.label}
          </span>
        );
      case 'submenu':
        return (
          <DropdownMenu
            key={entry.id}
            entries={() => entry.items}
            label={entry.label}
            side="bottom"
          >
            <Button variant="ghost" size="sm" icon={entry.icon} disabled={entry.disabled ?? false}>
              {entry.label}
              <ChevronDown size={14} aria-hidden />
            </Button>
          </DropdownMenu>
        );
      case 'check':
        return (
          <Button
            key={entry.id}
            variant="ghost"
            size="sm"
            aria-pressed={entry.checked}
            icon={entry.icon ?? (entry.checked ? <Check size={14} /> : undefined)}
            onClick={entry.onSelect}
          >
            {entry.label}
          </Button>
        );
      case 'item':
        return (
          <Button
            key={entry.id}
            variant="ghost"
            size="sm"
            icon={entry.icon}
            disabled={entry.disabled ?? false}
            className={entry.danger ? styles.dangerAction : undefined}
            onClick={entry.onSelect}
          >
            {entry.label}
          </Button>
        );
    }
  });
}
