import { useId, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import styles from './TextInput.module.css';

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Leading adornment (icon). */
  leading?: ReactNode;
  /** Trailing adornment (clear button…). */
  trailing?: ReactNode;
  size?: 'sm' | 'md';
  ref?: Ref<HTMLInputElement> | undefined;
}

export function TextInput({
  label,
  hint,
  error,
  leading,
  trailing,
  size = 'md',
  id,
  className,
  ref,
  ...rest
}: TextInputProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = `${inputId}-hint`;
  const describedBy = error || hint ? hintId : undefined;
  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')}>
      {label && (
        <label className={styles.label} htmlFor={inputId}>
          {label}
        </label>
      )}
      <div className={styles.field} data-size={size} data-invalid={error ? '' : undefined}>
        {leading && (
          <span className={styles.adornment} aria-hidden>
            {leading}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={styles.input}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...rest}
        />
        {trailing}
      </div>
      {(error ?? hint) && (
        <p id={hintId} className={styles.hint} data-error={error ? '' : undefined}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}
