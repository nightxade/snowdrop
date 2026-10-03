import { useState, type CSSProperties, type ReactNode } from 'react';
import styles from './Avatar.module.css';

export type AvatarSize = 16 | 20 | 24 | 32 | 40 | 48 | 80;

export interface AvatarProps {
  /** Image URL; falls back to `fallback` when missing or broken. */
  src?: string | undefined;
  /** Initials or an emoji, shown on `color` when there's no usable image. */
  fallback: string;
  /** Any CSS colour value (usually `var(--snowdrop-avatar-N)`). */
  color: string;
  size?: AvatarSize;
  shape?: 'circle' | 'rounded';
  /** Accessible name; omit when the avatar sits next to the same visible name. */
  label?: string;
  /** Bottom-right slot (typing dots, status…), cut out of the avatar with a ring. */
  status?: ReactNode;
  className?: string | undefined;
}

export function Avatar({
  src,
  fallback,
  color,
  size = 32,
  shape = 'circle',
  label,
  status,
  className,
}: AvatarProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showImage = src !== undefined && src !== '' && failedSrc !== src;
  const style = { '--avatar-size': `${size}px`, '--avatar-color': color } as CSSProperties;
  return (
    <span
      className={[styles.root, className].filter(Boolean).join(' ')}
      style={style}
      data-shape={shape}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      <span className={styles.face}>
        {showImage ? (
          <img
            className={styles.image}
            src={src}
            alt=""
            draggable={false}
            onError={() => {
              setFailedSrc(src);
            }}
          />
        ) : (
          <span className={styles.fallback}>{fallback}</span>
        )}
      </span>
      {status !== undefined && status !== null && <span className={styles.status}>{status}</span>}
    </span>
  );
}
