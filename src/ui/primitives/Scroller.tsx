import type { HTMLAttributes, Ref } from 'react';
import styles from './Scroller.module.css';

export interface ScrollerProps extends HTMLAttributes<HTMLDivElement> {
  /** 'thin' (default) shows a slim themed bar; 'none' hides it (rail). */
  scrollbar?: 'thin' | 'none';
  ref?: Ref<HTMLDivElement> | undefined;
}

/** A vertical scroll container with themed scrollbars that don't shift layout. */
export function Scroller({ scrollbar = 'thin', className, ref, ...rest }: ScrollerProps) {
  return (
    <div
      ref={ref}
      className={[styles.scroller, className].filter(Boolean).join(' ')}
      data-scrollbar={scrollbar}
      {...rest}
    />
  );
}
