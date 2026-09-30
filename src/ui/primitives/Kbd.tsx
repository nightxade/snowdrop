import { Fragment } from 'react';
import styles from './Kbd.module.css';

/** Renders a formatted combo ("Ctrl+Shift+M" or "⇧⌘M") as individual keycaps. */
export function Kbd({ combo, className }: { combo: string; className?: string | undefined }) {
  const keys = splitCombo(combo);
  return (
    <span className={[styles.combo, className].filter(Boolean).join(' ')}>
      {keys.map((key, i) => (
        <Fragment key={`${key}-${i}`}>
          <kbd className={styles.key}>{key}</kbd>
        </Fragment>
      ))}
    </span>
  );
}

/** "Ctrl+Shift+M" → ["Ctrl","Shift","M"]; "⇧⌘K" → ["⇧","⌘","K"]; "Ctrl++" keeps the plus. */
export function splitCombo(combo: string): string[] {
  if (combo.includes('+') && combo.length > 1) {
    const parts = combo.endsWith('++') ? [...combo.slice(0, -2).split('+'), '+'] : combo.split('+');
    return parts.filter((p) => p !== '');
  }
  const symbols = /^[⌃⌥⇧⌘]+/u.exec(combo)?.[0] ?? '';
  const rest = combo.slice(symbols.length);
  // Modifier glyphs are single BMP code points, so a per-character match is safe.
  return [...(symbols.match(/./gu) ?? []), ...(rest ? [rest] : [])];
}
