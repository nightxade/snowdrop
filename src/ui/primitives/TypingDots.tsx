import styles from './TypingDots.module.css';

/** Three pulsing dots; static under reduced motion. Decorative: pair it with text. */
export function TypingDots({ className }: { className?: string | undefined }) {
  return (
    <span className={[styles.dots, className].filter(Boolean).join(' ')} aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
