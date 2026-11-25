/**
 * Thin, styled wrapper around cmdk (MIT): an accessible combobox + listbox
 * with keyboard selection. Filtering is always done by the caller
 * (`shouldFilter={false}`) so ranking and highlighting stay ours.
 */
import { Command } from 'cmdk';
import { Check } from 'lucide-react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { VirtualList, type VirtualListHandle, VIRTUAL_THRESHOLD } from './VirtualList';
import styles from './CommandPalette.module.css';

export interface CommandPaletteProps {
  /** Accessible name of the whole palette. */
  label: string;
  /** Controlled active item (its `value`). */
  value?: string;
  onValueChange?: (value: string) => void;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * What a long (windowed) list tells the palette. cmdk only knows the rows that
 * are mounted: it forgets the highlighted row when it scrolls out of the
 * window and cannot step past the edge, so the palette keeps the selection
 * and does the keyboard movement from this model instead.
 */
interface WindowedNav {
  /** The values of the selectable rows, in order. */
  values: readonly string[];
  /** Brings the row into view (mounting it). */
  reveal: (value: string) => void;
  /** Chooses the row, as Enter on it would. */
  choose: (value: string) => void;
}

const WindowedNavContext = createContext<((nav: WindowedNav | null) => void) | null>(null);

/**
 * Whether a highlight change from cmdk is its own re-selection (the row that
 * was highlighted unmounted) rather than the user's: in a windowed list
 * (`windowed` = its selectable values) with the current row still in the
 * list, only the pointer may move the highlight.
 */
export function ignoresReselect(
  windowed: readonly string[] | undefined,
  current: string | undefined,
  next: string,
  pointer: boolean,
): boolean {
  return (
    windowed !== undefined &&
    !pointer &&
    current !== undefined &&
    current !== next &&
    windowed.includes(current)
  );
}

export function CommandPalette({
  label,
  value,
  onValueChange,
  children,
  className,
}: CommandPaletteProps) {
  const nav = useRef<WindowedNav | null>(null);
  /** The pointer (hover or click) is what is changing the highlight right now. */
  const pointer = useRef(false);
  const register = useCallback((next: WindowedNav | null) => {
    nav.current = next;
  }, []);
  /**
   * In a windowed list cmdk re-highlights the first mounted row when the
   * highlighted one unmounts (it scrolled away). That is not the user's
   * choice: keep the selection while its row still exists.
   */
  const changed = (next: string) => {
    if (ignoresReselect(nav.current?.values, value, next, pointer.current)) return;
    onValueChange?.(next);
  };
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    const windowed = nav.current;
    if (!windowed || windowed.values.length === 0 || value === undefined || !onValueChange) return;
    if (event.nativeEvent.isComposing || event.key === 'Process') return;
    if (event.altKey || event.shiftKey) return;
    const { values } = windowed;
    const last = values.length - 1;
    const at = values.indexOf(value);
    const vim = event.ctrlKey && !event.metaKey;
    let to: number | null = null;
    if (event.key === 'Enter' && !event.ctrlKey && !event.metaKey) {
      const chosen = values[at];
      if (chosen === undefined) return;
      event.preventDefault();
      event.stopPropagation();
      windowed.choose(chosen);
      return;
    }
    if (event.ctrlKey && event.metaKey) return;
    if (event.key === 'Home' && !event.ctrlKey && !event.metaKey) to = 0;
    else if (event.key === 'End' && !event.ctrlKey && !event.metaKey) to = last;
    else if (event.key === 'ArrowDown' && event.metaKey) to = last;
    else if (event.key === 'ArrowUp' && event.metaKey) to = 0;
    else if (event.key === 'ArrowDown' || (vim && (event.key === 'n' || event.key === 'j'))) {
      to = at === -1 || at === last ? 0 : at + 1;
    } else if (event.key === 'ArrowUp' || (vim && (event.key === 'p' || event.key === 'k'))) {
      to = at <= 0 ? last : at - 1;
    }
    if (to === null) return;
    const target = values[to];
    if (target === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    onValueChange(target);
    windowed.reveal(target);
  };
  return (
    <Command
      label={label}
      shouldFilter={false}
      loop
      onKeyDownCapture={onKeyDownCapture}
      onPointerMoveCapture={() => {
        pointer.current = true;
      }}
      onPointerMove={() => {
        pointer.current = false;
      }}
      onClickCapture={() => {
        pointer.current = true;
      }}
      onClick={() => {
        pointer.current = false;
      }}
      className={[styles.palette, className].filter(Boolean).join(' ')}
      {...(value !== undefined ? { value } : {})}
      onValueChange={changed}
    >
      <WindowedNavContext.Provider value={register}>{children}</WindowedNavContext.Provider>
    </Command>
  );
}

export function CommandPaletteInput({
  leading,
  trailing,
  ...props
}: ComponentProps<typeof Command.Input> & { leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className={styles.field}>
      {leading && <span className={styles.leading}>{leading}</span>}
      <Command.Input className={styles.input} {...props} />
      {trailing}
    </div>
  );
}

/**
 * The results listbox. Pass `empty` when there are no results: the listbox
 * then stays mounted but hidden (the input's aria-controls still resolves,
 * and an option-less listbox never reaches the accessibility tree), and the
 * message is announced from a status region outside it.
 */
export function CommandPaletteList({
  children,
  label,
  empty,
  multiselectable,
}: {
  children: ReactNode;
  label: string;
  empty?: ReactNode;
  /** The items are checked on and off (see `CommandPaletteItem`'s `checked`). */
  multiselectable?: boolean;
}) {
  const isEmpty = empty !== undefined && empty !== null && empty !== false;
  return (
    <>
      <Command.List
        className={styles.list}
        label={label}
        hidden={isEmpty}
        {...(multiselectable ? { 'aria-multiselectable': true } : {})}
      >
        {children}
      </Command.List>
      {isEmpty && (
        <div className={styles.empty} role="status">
          {empty}
        </div>
      )}
    </>
  );
}

export function CommandPaletteGroup({
  heading,
  children,
}: {
  heading?: string;
  children: ReactNode;
}) {
  return (
    <Command.Group className={styles.group} heading={heading}>
      {children}
    </Command.Group>
  );
}

export interface CommandPaletteItemProps {
  /** Unique id of the item (also what `value` refers to). */
  value: string;
  onSelect: () => void;
  icon?: ReactNode;
  children: ReactNode;
  /** Right-aligned extras: space name, badge, shortcut. */
  meta?: ReactNode;
  disabled?: boolean;
  /**
   * Makes the item a checkable one (a multi-pick list): a box shows before it
   * and `aria-checked` says whether it's ticked. Selecting still calls `onSelect`.
   */
  checked?: boolean;
  /** Where this item sits among all of them, when only some are in the page (a windowed list). */
  position?: { index: number; size: number };
}

export function CommandPaletteItem({
  value,
  onSelect,
  icon,
  children,
  meta,
  disabled,
  checked,
  position,
}: CommandPaletteItemProps) {
  return (
    <Command.Item
      className={styles.item}
      value={value}
      onSelect={onSelect}
      disabled={disabled ?? false}
      {...(checked !== undefined ? { 'aria-checked': checked } : {})}
      {...(position ? { 'aria-posinset': position.index + 1, 'aria-setsize': position.size } : {})}
    >
      {checked !== undefined && (
        <span className={styles.check} data-checked={checked ? '' : undefined} aria-hidden>
          {checked && <Check size={12} strokeWidth={3} />}
        </span>
      )}
      {icon && (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      )}
      <span className={styles.label}>{children}</span>
      {meta && <span className={styles.meta}>{meta}</span>}
    </Command.Item>
  );
}

export type PaletteRow =
  | { type: 'heading'; key: string; text: string }
  | ({ type: 'item'; key: string } & Omit<CommandPaletteItemProps, 'position'>);

/** The most rows of a palette that are mounted at once before it is windowed. */
export const PALETTE_WINDOW = VIRTUAL_THRESHOLD;

/**
 * The palette's rows: headings and items in one flat list. A short list is
 * rendered as cmdk groups; a long one is windowed, so only the rows near the
 * viewport exist (thousands of contacts would otherwise each register with
 * cmdk and mount an avatar).
 */
export function CommandPaletteRows({ rows }: { rows: readonly PaletteRow[] }) {
  const register = useContext(WindowedNavContext);
  const handle = useRef<VirtualListHandle | null>(null);
  const windowed = rows.length > PALETTE_WINDOW;
  const { values, itemNumber, itemCount } = useMemo(() => {
    const values: string[] = [];
    const itemNumber: number[] = [];
    let count = 0;
    for (const row of rows) {
      itemNumber.push(count);
      if (row.type !== 'item') continue;
      count++;
      if (!row.disabled) values.push(row.value);
    }
    return { values, itemNumber, itemCount: count };
  }, [rows]);

  useEffect(() => {
    if (!register || !windowed) return;
    register({
      values,
      reveal: (value) => {
        const at = rows.findIndex((r) => r.type === 'item' && r.value === value);
        // A row right under a heading brings the heading along.
        handle.current?.scrollIntoView(at > 0 && rows[at - 1]?.type === 'heading' ? at - 1 : at);
      },
      choose: (value) => {
        const row = rows.find((r) => r.type === 'item' && r.value === value);
        if (row?.type === 'item' && !row.disabled) row.onSelect();
      },
    });
    return () => {
      register(null);
    };
  }, [register, windowed, values, rows]);

  if (!windowed) {
    const groups: { key: string; heading: string | undefined; items: PaletteRow[] }[] = [];
    for (const row of rows) {
      if (row.type === 'heading') groups.push({ key: row.key, heading: row.text, items: [] });
      else {
        if (groups.length === 0) groups.push({ key: 'rows', heading: undefined, items: [] });
        groups[groups.length - 1]?.items.push(row);
      }
    }
    return (
      <>
        {groups.map((group) => (
          <CommandPaletteGroup
            key={group.key}
            {...(group.heading ? { heading: group.heading } : {})}
          >
            {group.items.map((row) => {
              if (row.type !== 'item') return null;
              const { type: _type, key, ...item } = row;
              return <CommandPaletteItem key={key} {...item} />;
            })}
          </CommandPaletteGroup>
        ))}
      </>
    );
  }

  return (
    <VirtualList
      handleRef={handle}
      count={rows.length}
      rowHeight={40}
      maxHeight="calc(min(380px, calc(52 * var(--snowdrop-vh))) - 2 * var(--snowdrop-space-3))"
      itemKey={(index) => rows[index]?.key ?? String(index)}
      itemContent={(index) => {
        const row = rows[index];
        if (!row) return null;
        if (row.type === 'heading') {
          return (
            <div role="presentation" className={styles.windowHeading}>
              {row.text}
            </div>
          );
        }
        const { type: _type, key, ...item } = row;
        return (
          <CommandPaletteItem
            key={key}
            {...item}
            position={{ index: itemNumber[index] ?? 0, size: itemCount }}
          />
        );
      }}
    />
  );
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
