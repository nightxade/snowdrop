import * as RadixContext from '@radix-ui/react-context-menu';
import * as RadixDropdown from '@radix-ui/react-dropdown-menu';
import { Check, ChevronRight } from 'lucide-react';
import type { HTMLAttributes, ReactElement, Ref } from 'react';
import { tidyMenu, type MenuEntry } from './menuModel';
import styles from './Menu.module.css';

/**
 * Radix's ContextMenu and DropdownMenu share one anatomy; this picks the parts
 * so both menus render the same entries with the same styling and keyboard
 * behaviour (arrows, typeahead, → opens submenus, Esc closes).
 */
type Parts = typeof RadixContext | typeof RadixDropdown;

function Entries({ parts: P, entries }: { parts: Parts; entries: readonly MenuEntry[] }) {
  return tidyMenu(entries).map((entry) => {
    switch (entry.kind) {
      case 'separator':
        return <P.Separator key={entry.id} className={styles.separator} />;
      case 'label':
        return (
          <P.Label key={entry.id} className={styles.label}>
            {entry.label}
          </P.Label>
        );
      case 'check':
        return (
          <P.CheckboxItem
            key={entry.id}
            className={styles.item}
            checked={entry.checked}
            onSelect={entry.onSelect}
          >
            <span className={styles.text}>{entry.label}</span>
            <span className={styles.check} aria-hidden>
              <P.ItemIndicator>
                <Check size={16} strokeWidth={2.5} />
              </P.ItemIndicator>
            </span>
          </P.CheckboxItem>
        );
      case 'submenu':
        return (
          <P.Sub key={entry.id}>
            <P.SubTrigger className={styles.item}>
              <span className={styles.text}>{entry.label}</span>
              <ChevronRight className={styles.chevron} size={16} aria-hidden />
            </P.SubTrigger>
            <P.Portal>
              <P.SubContent className={styles.content} sideOffset={6} alignOffset={-6}>
                <Entries parts={P} entries={entry.items} />
              </P.SubContent>
            </P.Portal>
          </P.Sub>
        );
      case 'item':
        return (
          <P.Item
            key={entry.id}
            className={styles.item}
            data-danger={entry.danger ? '' : undefined}
            disabled={entry.disabled ?? false}
            onSelect={entry.onSelect}
          >
            <span className={styles.text}>{entry.label}</span>
            {entry.hint && <span className={styles.hint}>{entry.hint}</span>}
            {entry.icon && (
              <span className={styles.icon} aria-hidden>
                {entry.icon}
              </span>
            )}
          </P.Item>
        );
    }
  });
}

/**
 * Props the wrappers pass through to their trigger, so they compose with other
 * `asChild` wrappers (e.g. a Tooltip around a ContextMenu around a button).
 */
type TriggerPassthrough = Omit<HTMLAttributes<HTMLElement>, 'children'> & {
  ref?: Ref<HTMLButtonElement> | undefined;
};

/** Builds entries only when the menu content actually mounts (i.e. is open). */
function LazyEntries({ parts, build }: { parts: Parts; build: () => readonly MenuEntry[] }) {
  return <Entries parts={parts} entries={build()} />;
}

export interface ContextMenuProps extends TriggerPassthrough {
  /** Built lazily when the menu opens, so rows don't compute menus they never show. */
  entries: () => readonly MenuEntry[];
  children: ReactElement;
  onOpenChange?: (open: boolean) => void;
  label?: string;
}

export function ContextMenu({
  entries,
  children,
  onOpenChange,
  label,
  ...trigger
}: ContextMenuProps) {
  return (
    <RadixContext.Root {...(onOpenChange ? { onOpenChange } : {})} modal={false}>
      <RadixContext.Trigger asChild {...trigger}>
        {children}
      </RadixContext.Trigger>
      <RadixContext.Portal>
        <RadixContext.Content
          className={styles.content}
          collisionPadding={8}
          {...(label ? { 'aria-label': label } : {})}
        >
          <LazyEntries parts={RadixContext} build={entries} />
        </RadixContext.Content>
      </RadixContext.Portal>
    </RadixContext.Root>
  );
}

export interface DropdownMenuProps extends TriggerPassthrough {
  entries: () => readonly MenuEntry[];
  /** The trigger button (must forward refs). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  label?: string;
}

export function DropdownMenu({
  entries,
  children,
  side = 'bottom',
  align = 'start',
  open,
  onOpenChange,
  label,
  ...trigger
}: DropdownMenuProps) {
  return (
    <RadixDropdown.Root
      {...(open !== undefined ? { open } : {})}
      {...(onOpenChange ? { onOpenChange } : {})}
    >
      <RadixDropdown.Trigger asChild {...trigger}>
        {children}
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          className={styles.content}
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          {...(label ? { 'aria-label': label } : {})}
        >
          <LazyEntries parts={RadixDropdown} build={entries} />
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  );
}
