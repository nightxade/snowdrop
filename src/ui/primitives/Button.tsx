import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { useSoftDisabled } from './useSoftDisabled';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon before the label. */
  icon?: ReactNode;
  fullWidth?: boolean;
  /**
   * Working: looks disabled and ignores activation, but is not `disabled`, so a focused button
   * keeps focus (WebKit drops focus to the page when the focused button becomes disabled). A
   * `disabled` button that has focus when it goes inert does the same until focus leaves it
   * (`useSoftDisabled`).
   */
  busy?: boolean | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  fullWidth,
  className,
  children,
  type = 'button',
  busy,
  disabled,
  onClick,
  onFocus,
  onBlur,
  ref,
  ...rest
}: ButtonProps) {
  // A button that goes inert while it has focus (its own action used up) keeps focus.
  const soft = useSoftDisabled(disabled);
  const inert = busy || soft.soft;
  return (
    <button
      ref={ref}
      type={type}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-full={fullWidth ? '' : undefined}
      aria-busy={busy ? true : undefined}
      aria-disabled={inert ? true : undefined}
      disabled={soft.hard}
      onFocus={(event) => {
        soft.onFocus(event);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        soft.onBlur(event);
        onBlur?.(event);
      }}
      onClick={
        inert
          ? (event) => {
              event.preventDefault();
            }
          : onClick
      }
      {...rest}
    >
      {icon && (
        <span className={styles.icon} aria-hidden>
          {icon}
        </span>
      )}
      {children}
    </button>
  );
}
