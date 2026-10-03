/**
 * Thin, styled wrapper around cmdk (MIT): an accessible combobox + listbox
 * with keyboard selection. Filtering is always done by the caller
 * (`shouldFilter={false}`) so ranking and highlighting stay ours.
 */
import { Command } from 'cmdk';
import type { ComponentProps, ReactNode } from 'react';
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

export function CommandPalette({
  label,
  value,
  onValueChange,
  children,
  className,
}: CommandPaletteProps) {
  return (
    <Command
      label={label}
      shouldFilter={false}
      loop
      className={[styles.palette, className].filter(Boolean).join(' ')}
      {...(value !== undefined ? { value } : {})}
      {...(onValueChange ? { onValueChange } : {})}
    >
      {children}
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
}: {
  children: ReactNode;
  label: string;
  empty?: ReactNode;
}) {
  const isEmpty = empty !== undefined && empty !== null && empty !== false;
  return (
    <>
      <Command.List className={styles.list} label={label} hidden={isEmpty}>
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
}

export function CommandPaletteItem({
  value,
  onSelect,
  icon,
  children,
  meta,
  disabled,
}: CommandPaletteItemProps) {
  return (
    <Command.Item
      className={styles.item}
      value={value}
      onSelect={onSelect}
      disabled={disabled ?? false}
    >
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
