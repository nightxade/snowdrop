import { useId, type ReactNode } from 'react';
import { useSettingsFilter } from './SettingsFilter';
import styles from './rows.module.css';

export interface SettingsSectionProps {
  /** Matches `SettingsEntry.section` so search can hide empty sections. */
  id?: string;
  title?: string;
  description?: ReactNode;
  children: ReactNode;
  /** Trailing header content (e.g. "Reset all"). */
  actions?: ReactNode;
}

export function SettingsSection({
  id,
  title,
  description,
  children,
  actions,
}: SettingsSectionProps) {
  const filter = useSettingsFilter();
  const headingId = useId();
  if (id && !filter.isSectionVisible(id)) return null;
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
