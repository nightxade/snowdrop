import { useStore } from 'zustand';
import { conversationsSelectors, sessionSelectors } from '@/core/stores';
import { useHearth } from './HearthProvider';
import styles from './App.module.css';

/**
 * Placeholder shell proving the wiring end to end (backend → sync → stores →
 * React). Replaced by the real layout in P2.
 */
export function App() {
  const { stores } = useHearth();
  const status = useStore(stores.session, sessionSelectors.status);
  const ready = useStore(stores.session, sessionSelectors.ready);
  const conversations = useStore(stores.conversations, conversationsSelectors.ordered);

  return (
    <main className={styles.root} data-hearth="app">
      <h1 className={styles.title}>Hearth — foundation ready</h1>
      <p className={styles.meta} aria-live="polite">
        {ready ? `${conversations.length} conversations` : 'Connecting…'} · {status}
      </p>
    </main>
  );
}
