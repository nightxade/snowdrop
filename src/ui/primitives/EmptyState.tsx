import type { ReactNode } from 'react';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  size?: 'sm' | 'lg';
  className?: string | undefined;
}

export function EmptyState({
  icon,
  title,
  children,
  action,
  size = 'lg',
  className,
}: EmptyStateProps) {
  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')} data-size={size}>
      {icon && (
        <div className={styles.icon} aria-hidden>
          {icon}
        </div>
      )}
      <p className={styles.title}>{title}</p>
      {children && <div className={styles.body}>{children}</div>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
