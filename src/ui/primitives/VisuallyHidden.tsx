import type { ReactNode } from 'react';
import styles from './VisuallyHidden.module.css';

export function VisuallyHidden({
  children,
  id,
  role,
}: {
  children: ReactNode;
  id?: string;
  /** "status" makes it a polite live region (announces changes). */
  role?: 'status';
}) {
  return (
    <span
      className={styles.hidden}
      {...(id !== undefined ? { id } : {})}
      {...(role !== undefined ? { role } : {})}
    >
      {children}
    </span>
  );
}
