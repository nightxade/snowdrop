import { EmojiPicker as Picker, type EmojiPickerListCategoryHeaderProps } from 'frimousse';
import type { EmojiPickerListEmojiProps, EmojiPickerListRowProps } from 'frimousse';
import styles from './EmojiPicker.module.css';

import { EMOJIBASE_URL, type EmojiPickerProps } from './emojiPickerTypes';

function CategoryHeader({ category, ...props }: EmojiPickerListCategoryHeaderProps) {
  return (
    <div className={styles.category} {...props}>
      {category.label}
    </div>
  );
}

/**
 * frimousse numbers rows from 0, but aria-rowindex is 1-based (axe flags 0).
 * It also finds the active row by that attribute to scroll it into view, so
 * the lookup now lands one row early; the row's scroll margins (see
 * .row in the CSS) shift its maths back by exactly one row height.
 */
function Row({ children, ...props }: EmojiPickerListRowProps) {
  const index = props['aria-rowindex'];
  return (
    <div
      className={styles.row}
      {...props}
      {...(typeof index === 'number' ? { 'aria-rowindex': index + 1 } : {})}
    >
      {children}
    </div>
  );
}

function EmojiButton({ emoji, ...props }: EmojiPickerListEmojiProps) {
  // aria-colindex is 1-based; frimousse emits 0-based (and never reads it back).
  const col = props['aria-colindex'];
  return (
    <button
      className={styles.emoji}
      data-active={emoji.isActive ? '' : undefined}
      aria-label={emoji.label}
      {...props}
      {...(typeof col === 'number' ? { 'aria-colindex': col + 1 } : {})}
    >
      {emoji.emoji}
    </button>
  );
}

/** Searchable, keyboard-navigable emoji grid (frimousse, themed with tokens). Loaded lazily. */
export function EmojiPickerPanel({ onSelect, autoFocus = true, columns = 9 }: EmojiPickerProps) {
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
      {/* Focusable so keyboard users can scroll it (axe: scrollable-region-focusable). */}
      <Picker.Viewport className={styles.viewport} tabIndex={0}>
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
