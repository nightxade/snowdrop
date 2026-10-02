import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import styles from './FormControls.module.css';

export interface SegmentedOption<V extends string> {
  value: V;
  label: ReactNode;
  /** Accessible name when the label is an icon. */
  ariaLabel?: string;
}

export interface SegmentedProps<V extends string> {
  value: V;
  options: readonly SegmentedOption<V>[];
  onValueChange: (value: V) => void;
  /** Accessible name of the group (used when there's no visible label). */
  label: string;
  /** Id of a visible label naming the group (settings rows); wins over `label`. */
  labelledBy?: string | undefined;
  className?: string | undefined;
}

/** A radio group drawn as a segmented control; arrows move and select (WAI-ARIA radio pattern). */
export function Segmented<V extends string>({
  value,
  options,
  onValueChange,
  label,
  labelledBy,
  className,
}: SegmentedProps<V>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (e: KeyboardEvent, index: number) => {
    const delta =
      e.key === 'ArrowRight' || e.key === 'ArrowDown'
        ? 1
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp'
          ? -1
          : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (index + delta + options.length) % options.length;
    const option = options[next];
    if (!option) return;
    onValueChange(option.value);
    refs.current[next]?.focus();
  };
  return (
    <div
      role="radiogroup"
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label })}
      className={[styles.segmented, className].filter(Boolean).join(' ')}
    >
      {options.map((o, i) => {
        const checked = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={o.ariaLabel}
            tabIndex={checked ? 0 : -1}
            className={styles.segment}
            onClick={() => {
              onValueChange(o.value);
            }}
            onKeyDown={(e) => {
              onKeyDown(e, i);
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
