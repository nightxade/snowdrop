import { useId, type ReactNode } from 'react';
import { useSettingsFilter } from './SettingsFilter';
import styles from './rows.module.css';

export interface ControlIds {
  id: string;
  labelId: string;
  descriptionId: string | undefined;
}

export interface SettingRowProps {
  /** Entry id from the settings map (search visibility). */
  id: string;
  label: string;
  description?: ReactNode;
  /** The control; a function receives ids for aria-labelledby / htmlFor wiring. */
  control?: ReactNode | ((ids: ControlIds) => ReactNode);
  /** Put the control under the text (wide controls: cards, colours, editors). */
  stacked?: boolean;
  /** Inline note under the row (warning, status). */
  note?: ReactNode;
  noteTone?: 'info' | 'warning' | 'danger' | 'success';
  disabled?: boolean;
  children?: ReactNode;
}

/**
 * One setting: label and description on the left, its control on the right
 * (or below when `stacked`). Plugin settings forms are built from the same
 * row, so every setting in the app reads the same way.
 */
export function SettingRow({
  id,
  label,
  description,
  control,
  stacked,
  note,
  noteTone = 'info',
  disabled,
  children,
}: SettingRowProps) {
  const filter = useSettingsFilter();
  const base = useId();
  if (!filter.isVisible(id)) return null;
  const ids: ControlIds = {
    id: `${base}-control`,
    labelId: `${base}-label`,
    descriptionId: description ? `${base}-description` : undefined,
  };
  const rendered = typeof control === 'function' ? control(ids) : control;
  return (
    <div
      className={styles.row}
      data-stacked={stacked ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      data-setting={id}
    >
      <div className={styles.text}>
        <label id={ids.labelId} htmlFor={ids.id} className={styles.label}>
          {label}
        </label>
        {description && (
          <p id={ids.descriptionId} className={styles.description}>
            {description}
          </p>
        )}
      </div>
      {rendered !== undefined && rendered !== null && (
        <div className={styles.control}>{rendered}</div>
      )}
      {children && <div className={styles.extra}>{children}</div>}
      {note && (
        <p
          className={styles.note}
          data-tone={noteTone}
          role={noteTone === 'info' ? undefined : 'status'}
        >
          {note}
        </p>
      )}
    </div>
  );
}
