import type { ReactNode } from 'react';
import styles from './VisuallyHidden.module.css';

export function VisuallyHidden({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <span className={styles.hidden} {...(id !== undefined ? { id } : {})}>
      {children}
    </span>
  );
}
