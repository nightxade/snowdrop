import { ChevronDown, Ellipsis } from 'lucide-react';
import type { ReactNode } from 'react';
import { ContextMenu, DropdownMenu, IconButton, type MenuEntry } from '@/ui/primitives';
import styles from './SectionHeader.module.css';

export function SectionHeader({
  title,
  collapsed,
  onToggle,
  controls,
  trailing,
  entries,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** id of the list this header expands/collapses. */
  controls: string;
  trailing?: ReactNode;
  /** Category menu (spaces): right-click / Shift+F10 on the header, plus a hover button. */
  entries?: () => readonly MenuEntry[];
}) {
  return (
    <div className={styles.header} data-snowdrop="section-header">
      {entries ? (
        <ContextMenu entries={entries} label={`${title} options`}>
          <button
            type="button"
            className={styles.toggle}
            aria-expanded={!collapsed}
            aria-controls={controls}
            data-roving-item
            tabIndex={-1}
            onClick={onToggle}
          >
            <ChevronDown className={styles.chevron} size={12} strokeWidth={2.5} aria-hidden />
            <span className={styles.title}>{title}</span>
          </button>
        </ContextMenu>
      ) : (
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls={controls}
          data-roving-item
          tabIndex={-1}
          onClick={onToggle}
        >
          <ChevronDown className={styles.chevron} size={12} strokeWidth={2.5} aria-hidden />
          <span className={styles.title}>{title}</span>
        </button>
      )}
      {trailing}
      {entries && (
        <DropdownMenu entries={entries} align="start" label={`${title} options`}>
          <IconButton
            size="sm"
            className={styles.more}
            label={`${title} options`}
            icon={<Ellipsis />}
            tabIndex={-1}
          />
        </DropdownMenu>
      )}
    </div>
  );
}
