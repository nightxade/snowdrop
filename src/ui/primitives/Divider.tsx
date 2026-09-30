import styles from './Divider.module.css';

export function Divider({
  orientation = 'horizontal',
  className,
}: {
  orientation?: 'horizontal' | 'vertical';
  className?: string | undefined;
}) {
  return (
    <span
      role="separator"
      aria-orientation={orientation}
      className={[styles.divider, className].filter(Boolean).join(' ')}
      data-orientation={orientation}
    />
  );
}
