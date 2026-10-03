import { useId, type ReactNode } from 'react';
import { useSettingsFilter } from './SettingsFilter';
import styles from './rows.module.css';

export interface SettingsSectionProps {
  /** Matches `SettingsEntry.section` so search can hide empty sections. */
  id?: string;
  /**
   * The entry ids of the rows inside, for sections without a registered
   * `id` (keybind categories): under a search, the section and its heading
   * disappear when none of them match.
   */
  rowIds?: readonly string[];
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Trailing header content (e.g. "Reset all"). */
  actions?: ReactNode;
}

export function SettingsSection({
  id,
  rowIds,
  title,
  description,
  children,
  actions,
}: SettingsSectionProps) {
  const filter = useSettingsFilter();
  const headingId = useId();
  if (id && !filter.isSectionVisible(id)) return null;
  if (rowIds && !rowIds.some((row) => filter.isVisible(row))) return null;
  return (
    <section className={styles.section} aria-labelledby={title ? headingId : undefined}>
      {(title ?? actions) && (
        <header className={styles.sectionHeader}>
          <div>
            {title && (
              <h3 id={headingId} className={styles.sectionTitle}>
                {title}
              </h3>
            )}
            {description && <p className={styles.sectionDescription}>{description}</p>}
          </div>
          {actions && <div className={styles.sectionActions}>{actions}</div>}
        </header>
      )}
      <div className={styles.rows}>{children}</div>
    </section>
  );
}
