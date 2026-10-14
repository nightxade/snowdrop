import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from 'react';
import { Badge, ContextMenu, Tooltip, type MenuEntry } from '@/ui/primitives';
import styles from './RailTile.module.css';

export interface RailTileProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  selected?: boolean;
  unread?: boolean;
  mentions?: number;
  /** CSS colour for hover/selected fill (a space's hue). */
  hue?: string;
  /** 'accent' = the Home and add tiles, which fill with the accent instead of a hue. */
  tone?: 'hue' | 'accent' | 'quiet';
  menu?: () => readonly MenuEntry[];
  /** Content of the tile: emoji, initials, glyph. */
  children: ReactNode;
  /** Applied to the tile's wrapper (drag transforms). */
  wrapperStyle?: CSSProperties | undefined;
  wrapperRef?: Ref<HTMLDivElement> | undefined;
  dragging?: boolean;
  ref?: Ref<HTMLButtonElement> | undefined;
}

/**
 * One rail tile. The language is Snowdrop's own: a constant-radius tile that
 * fills with its hue on hover, an accent ring (offset from the tile) for the
 * selected space, a small light pip at the rail's edge for unread, and a
 * mention badge at the bottom-right.
 */
export function RailTile({
  label,
  selected = false,
  unread = false,
  mentions = 0,
  hue,
  tone = 'hue',
  menu,
  children,
  wrapperStyle,
  wrapperRef,
  dragging,
  className,
  ref,
  ...button
}: RailTileProps) {
  const a11yLabel = [
    label,
    mentions > 0 ? `${mentions} mention${mentions === 1 ? '' : 's'}` : unread ? 'unread' : '',
  ]
    .filter(Boolean)
    .join(', ');
  const tile = (
    <button
      ref={ref}
      type="button"
      className={[styles.tile, className].filter(Boolean).join(' ')}
      aria-label={a11yLabel}
      aria-current={selected ? 'page' : undefined}
      data-roving-item
      // TUI shell only (src/ui/styles/tui.css): the text it lists the tile by,
      // and whether to mark it current — inert markup otherwise.
      data-rail-label={label}
      data-selected={selected ? '' : undefined}
      tabIndex={selected ? 0 : -1}
      {...button}
    >
      {children}
    </button>
  );
  return (
    <div
      ref={wrapperRef}
      className={styles.item}
      style={{ ...(hue ? { '--tile-hue': hue } : {}), ...wrapperStyle }}
      data-selected={selected ? '' : undefined}
      data-unread={unread ? '' : undefined}
      data-tone={tone}
      data-dragging={dragging ? '' : undefined}
    >
      <Tooltip label={label} side="right" disabled={dragging ?? false}>
        {menu ? (
          <ContextMenu entries={menu} label={`${label} options`}>
            {tile}
          </ContextMenu>
        ) : (
          tile
        )}
      </Tooltip>
      {unread && <span className={styles.dot} aria-hidden />}
      {mentions > 0 && <Badge variant="mention" count={mentions} className={styles.badge} />}
    </div>
  );
}
