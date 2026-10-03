import { useId, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
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
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  // Radio-group keyboard: one tab stop (the checked swatch, else the first); arrows move and pick.
  const checkedIndex = presets.findIndex((p) => p.value.toLowerCase() === current);
  const tabStop = checkedIndex === -1 ? 0 : checkedIndex;
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + presets.length) % presets.length;
    const preset = presets[next];
    if (!preset) return;
    onValueChange(preset.value.toLowerCase());
    refs.current[next]?.focus();
  };
  const invalid = hex !== '' && hex !== '#' && !HEX.test(hex);
  return (
    <div className={styles.color}>
      <div role="radiogroup" aria-label={label} className={styles.swatches}>
        {presets.map((p, i) => (
          <button
            key={p.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            tabIndex={i === tabStop ? 0 : -1}
            onKeyDown={(e) => {
              onKeyDown(e, i);
            }}
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
          placeholder="#5fbf9f"
          maxLength={7}
          aria-invalid={invalid || undefined}
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
