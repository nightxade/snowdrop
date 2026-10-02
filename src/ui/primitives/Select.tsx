import { ChevronDown } from 'lucide-react';
import type { Ref, SelectHTMLAttributes } from 'react';
import styles from './FormControls.module.css';

export interface SelectOption<V extends string = string> {
  value: V;
  label: string;
}

export interface SelectProps<V extends string = string> extends Omit<
  SelectHTMLAttributes<HTMLSelectElement>,
  'value' | 'onChange'
> {
  value: V;
  options: readonly SelectOption<V>[];
  onValueChange: (value: V) => void;
  ref?: Ref<HTMLSelectElement> | undefined;
}

/** A native <select> (best keyboard/screen-reader support there is), styled to match. */
export function Select<V extends string = string>({
  value,
  options,
  onValueChange,
  className,
  ref,
  ...rest
}: SelectProps<V>) {
  return (
    <span className={[styles.selectWrap, className].filter(Boolean).join(' ')}>
      <select
        ref={ref}
        className={styles.select}
        value={value}
        onChange={(e) => {
          const next = options.find((o) => o.value === e.target.value);
          if (next) onValueChange(next.value);
        }}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className={styles.selectChevron} size={16} aria-hidden />
    </span>
  );
}
