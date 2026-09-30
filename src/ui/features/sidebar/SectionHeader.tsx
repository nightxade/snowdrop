import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import styles from './SectionHeader.module.css';

export function SectionHeader({
  title,
  collapsed,
  onToggle,
  controls,
  trailing,
}: {
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  /** id of the list this header expands/collapses. */
  controls: string;
  trailing?: ReactNode;
}) {
  return (
    <div className={styles.header} data-hearth="section-header">
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
      {trailing}
    </div>
  );
}
