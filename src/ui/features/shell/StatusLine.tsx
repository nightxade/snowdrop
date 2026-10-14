import { CoreCommand } from '@/core/commands';
import { useObservableList, useSnowdrop } from '@/ui/hooks';
import { Slot } from '@/ui/primitives';
import styles from './StatusLine.module.css';

/**
 * TUI shell only (`AppShell`): a bottom bar built from the `status.items`
 * slot — core contributes the open conversation, total unread and
 * connection state (`src/app/statusItems.tsx`); the Vim Mode plugin adds its
 * NORMAL/INSERT item the same way, without this component knowing it
 * exists. "? for keys" always shows, on the right, and opens the same
 * keyboard-shortcuts dialog as Ctrl+/.
 */
export function StatusLine() {
  const app = useSnowdrop();
  const items = useObservableList(app.registries.statusItems);
  return (
    <footer className={styles.bar} data-snowdrop="status-line">
      <Slot name="status.items" entries={items} props={{}} className={styles.items} />
      <button
        type="button"
        className={styles.help}
        onClick={() => {
          void app.commands.execute(CoreCommand.ShortcutHelp);
        }}
      >
        ? for keys
      </button>
    </footer>
  );
}
