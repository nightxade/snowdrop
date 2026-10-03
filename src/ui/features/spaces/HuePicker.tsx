import type { CSSProperties } from 'react';
import { useId } from 'react';
import styles from './SpaceForm.module.css';

const HUES = Array.from({ length: 12 }, (_, i) => i + 1);

/** The 12 avatar hues as a radio group (arrow keys move, as native radios). */
export function HuePicker({
  value,
  onChange,
  label = 'Colour',
  allowNone = false,
}: {
  value: number | null;
  onChange: (hue: number | null) => void;
  label?: string;
  allowNone?: boolean;
}) {
  const labelId = useId();
  const name = useId();
  return (
    <div className={styles.group}>
      <span className={styles.label} id={labelId}>
        {label}
      </span>
      <div className={styles.choices} data-kind="hue" role="radiogroup" aria-labelledby={labelId}>
        {allowNone && (
          <label className={styles.swatchLabel} title="No colour">
            <input
              type="radio"
              name={name}
              className={styles.swatchInput}
              checked={value === null}
              onChange={() => {
                onChange(null);
              }}
              aria-label="No colour"
            />
            <span className={styles.swatch} data-none="" />
          </label>
        )}
        {HUES.map((hue) => (
          <label key={hue} className={styles.swatchLabel} title={`Colour ${hue}`}>
            <input
              type="radio"
              name={name}
              className={styles.swatchInput}
              checked={value === hue}
              onChange={() => {
                onChange(hue);
              }}
              aria-label={`Colour ${hue}`}
            />
            <span
              className={styles.swatch}
              style={{ '--tile-hue': `var(--snowdrop-avatar-${hue})` } as CSSProperties}
            />
          </label>
        ))}
      </div>
    </div>
  );
}
