import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  radius?: 'xs' | 'sm' | 'full';
  className?: string | undefined;
}

/** Placeholder block; shimmer stops under reduced motion (global.css) and while an ancestor marks it `data-shimmer="off"`. */
export function Skeleton({ width = '100%', height = 12, radius = 'xs', className }: SkeletonProps) {
  const style: CSSProperties = { width, height };
  return (
    <span
      className={[styles.skeleton, className].filter(Boolean).join(' ')}
      data-radius={radius}
      style={style}
      aria-hidden
    />
  );
}
