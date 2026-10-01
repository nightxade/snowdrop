import * as RadixPopover from '@radix-ui/react-popover';
import { EmojiPicker as Picker, type EmojiPickerListCategoryHeaderProps } from 'frimousse';
import type { EmojiPickerListEmojiProps, EmojiPickerListRowProps } from 'frimousse';
import type { ReactElement } from 'react';
import styles from './EmojiPicker.module.css';

/**
 * Emojibase data is served from our own origin (see devserver/emojibase.ts):
 * the library's default is a public CDN, which would leak picker usage.
 */
export const EMOJIBASE_URL = `${import.meta.env.BASE_URL}emojibase`;

export interface EmojiPickerProps {
  onSelect: (emoji: string) => void;
  /** Focus the search field on mount (default true). */
  autoFocus?: boolean;
  columns?: number;
}

function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div className={styles.category} {...props}>
      {category.label}
    </div>
  );
}

function Row({ children, ...props }: EmojiPickerListRowProps) {
  return (
    <div className={styles.row} {...props}>
      {children}
    </div>
  );
}

function EmojiButton({ emoji, ...props }: EmojiPickerListEmojiProps) {
  return (
    <button
      className={styles.emoji}
      data-active={emoji.isActive ? '' : undefined}
      aria-label={emoji.label}
      {...props}
    >
      {emoji.emoji}
    </button>
  );
}

/** Searchable, keyboard-navigable emoji grid (frimousse, themed with tokens). */
export function EmojiPicker({ onSelect, autoFocus = true, columns = 9 }: EmojiPickerProps) {
  return (
    <Picker.Root
      className={styles.root}
      columns={columns}
      emojibaseUrl={EMOJIBASE_URL}
      onEmojiSelect={(e) => {
        onSelect(e.emoji);
      }}
    >
      <div className={styles.header}>
        <Picker.Search
          className={styles.search}
          placeholder="Find an emoji"
          aria-label="Find an emoji"
          autoFocus={autoFocus}
        />
        <Picker.SkinToneSelector className={styles.skin} aria-label="Change skin tone" />
      </div>
      <Picker.Viewport className={styles.viewport}>
        <Picker.Loading className={styles.status}>Loading emoji…</Picker.Loading>
        <Picker.Empty className={styles.status}>
          {({ search }) => <>No emoji match “{search}”</>}
        </Picker.Empty>
        <Picker.List
          className={styles.list}
          components={{ CategoryHeader, Row, Emoji: EmojiButton }}
        />
      </Picker.Viewport>
      <div className={styles.footer} aria-hidden>
        <Picker.ActiveEmoji>
          {({ emoji }) =>
            emoji ? (
              <>
                <span className={styles.previewEmoji}>{emoji.emoji}</span>
                <span className={styles.previewLabel}>{emoji.label}</span>
              </>
            ) : (
              <span className={styles.previewHint}>Pick an emoji</span>
            )
          }
        </Picker.ActiveEmoji>
      </div>
    </Picker.Root>
  );
}

export interface EmojiPickerPopoverProps extends Omit<EmojiPickerProps, 'autoFocus'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The element the picker opens from (a button that forwards refs). */
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  /** Keep the picker open after a pick (e.g. adding several reactions). */
  stayOpen?: boolean;
}

/** The picker in a popover, anchored to (and toggled by) its child. */
export function EmojiPickerPopover({
  open,
  onOpenChange,
  children,
  side = 'top',
  align = 'end',
  onSelect,
  stayOpen,
  columns,
}: EmojiPickerPopoverProps) {
  return (
    <RadixPopover.Root open={open} onOpenChange={onOpenChange}>
      <RadixPopover.Trigger asChild>{children}</RadixPopover.Trigger>
      <RadixPopover.Portal>
        <RadixPopover.Content
          className={styles.popover}
          side={side}
          align={align}
          sideOffset={8}
          collisionPadding={12}
          aria-label="Emoji picker"
        >
          {open && (
            <EmojiPicker
              {...(columns !== undefined ? { columns } : {})}
              onSelect={(emoji) => {
                onSelect(emoji);
                if (!stayOpen) onOpenChange(false);
              }}
            />
          )}
        </RadixPopover.Content>
      </RadixPopover.Portal>
    </RadixPopover.Root>
  );
}
