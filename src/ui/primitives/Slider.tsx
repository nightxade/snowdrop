import type { CSSProperties, InputHTMLAttributes } from 'react';
import styles from './FormControls.module.css';

export interface SliderProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type'
> {
  value: number;
  min: number;
  max: number;
  step?: number;
  onValueChange: (value: number) => void;
  /** Visible value next to the track, e.g. "110%". */
  format?: (value: number) => string;
  /** Labels under the track's two ends, e.g. ["12 px", "20 px"]. */
  ticks?: readonly [string, string];
}

/** Native range input with a filled track and the current value as text. */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onValueChange,
  format = String,
  ticks,
  className,
  ...rest
}: SliderProps) {
  const fill = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const text = format(value);
  return (
    <span className={[styles.sliderWrap, className].filter(Boolean).join(' ')}>
      <span className={styles.slider}>
        <input
          type="range"
          className={styles.range}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={text}
          style={{ '--fill': `${fill}%` } as CSSProperties}
          onChange={(e) => {
            onValueChange(Number(e.target.value));
          }}
          {...rest}
        />
        <output className={styles.sliderValue} aria-hidden>
          {text}
        </output>
      </span>
      {ticks && (
        <span className={styles.sliderTicks} aria-hidden>
          <span>{ticks[0]}</span>
          <span>{ticks[1]}</span>
        </span>
      )}
    </span>
  );
}
