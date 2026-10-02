import styles from './SettingsFallback.module.css';

/** Shown for the moment the settings chunk loads: the same backdrop, so nothing flashes. */
export function SettingsFallback() {
  return <div className={styles.fallback} role="status" aria-label="Loading settings" />;
}
