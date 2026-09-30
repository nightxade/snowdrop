import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Tooltip } from './Tooltip';
import styles from './IconButton.module.css';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** Required: becomes the tooltip and the accessible name. */
  label: string;
  icon: ReactNode;
  shortcut?: string;
  /** Toggle state; also sets aria-pressed. */
  active?: boolean;
  size?: 'sm' | 'md';
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  /** Hide the tooltip (e.g. when the label is visible elsewhere). */
  noTooltip?: boolean;
  ref?: Ref<HTMLButtonElement> | undefined;
}

export function IconButton({
  label,
  icon,
  shortcut,
  active,
  size = 'md',
  tooltipSide = 'top',
  noTooltip,
  className,
  type = 'button',
  ref,
  ...rest
}: IconButtonProps) {
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      {...(active !== undefined ? { 'aria-pressed': active } : {})}
      className={[styles.button, className].filter(Boolean).join(' ')}
      data-size={size}
      data-active={active ? '' : undefined}
      {...rest}
    >
      {icon}
    </button>
  );
  return (
    <Tooltip
      label={label}
      side={tooltipSide}
      disabled={noTooltip ?? false}
      {...(shortcut ? { shortcut } : {})}
    >
      {button}
    </Tooltip>
  );
}
