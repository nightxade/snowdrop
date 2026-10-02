import { useId, useState, type CSSProperties } from 'react';
import styles from './FormControls.module.css';

export interface ColorFieldProps {
  /** #rrggbb, or null when nothing custom is chosen. */
  value: string | null;
  presets: readonly { value: string; label: string }[];
  onValueChange: (value: string) => void;
  label: string;
}

const HEX = /^#[0-9a-f]{6}$/iu;

/**
 * Preset swatches (radio group) plus a custom colour: the native picker and
 * a hex field, so any colour can be typed exactly.
 */
export function ColorField({ value, presets, onValueChange, label }: ColorFieldProps) {
  const id = useId();
  const current = value?.toLowerCase() ?? null;
  const [hex, setHex] = useState(current ?? '');
  const [lastValue, setLastValue] = useState(current);
  if (current !== lastValue) {
    setLastValue(current);
    setHex(current ?? '');
  }
  const isPreset = presets.some((p) => p.value.toLowerCase() === current);
  return (
    <div className={styles.color}>
      <div role="radiogroup" aria-label={label} className={styles.swatches}>
        {presets.map((p) => (
          <button
            key={p.value}
            type="button"
            role="radio"
            aria-checked={p.value.toLowerCase() === current}
            aria-label={p.label}
            title={p.label}
            className={styles.swatch}
            style={{ '--swatch': p.value } as CSSProperties}
            onClick={() => {
              onValueChange(p.value.toLowerCase());
            }}
          />
        ))}
      </div>
      <div className={styles.custom} data-active={current && !isPreset ? '' : undefined}>
        <input
          type="color"
          className={styles.colorInput}
          aria-label={`Custom ${label.toLowerCase()}`}
          value={current ?? '#808080'}
          onChange={(e) => {
            onValueChange(e.target.value.toLowerCase());
          }}
        />
        <label htmlFor={id} className={styles.srOnly}>
          Hex value
        </label>
        <input
          id={id}
          className={styles.hex}
          value={hex}
          placeholder="#d4744a"
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => {
            const next = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
            setHex(next);
            if (HEX.test(next)) onValueChange(next.toLowerCase());
          }}
        />
      </div>
    </div>
  );
}
