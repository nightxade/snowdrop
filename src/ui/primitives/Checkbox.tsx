import { Check } from 'lucide-react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import styles from './FormControls.module.css';

export interface CheckboxProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'onChange'
> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Row content after the box; the whole row is the label. */
  children?: ReactNode;
}

export function Checkbox({
  checked,
  onCheckedChange,
  children,
  className,
  ...rest
}: CheckboxProps) {
  return (
    <label className={[styles.checkRow, className].filter(Boolean).join(' ')}>
      <span className={styles.checkBox}>
        <input
          type="checkbox"
          className={styles.checkInput}
          checked={checked}
          onChange={(e) => {
            onCheckedChange(e.target.checked);
          }}
          {...rest}
        />
        <Check className={styles.checkMark} size={14} strokeWidth={3} aria-hidden />
      </span>
      {children}
    </label>
  );
}
