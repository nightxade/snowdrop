import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { formatKeybind, isMacPlatform, resolveKeybinds } from '@/core/commands';
import { useShrike } from '@/ui/hooks';
import { Button, Kbd, Modal } from '@/ui/primitives';
import styles from './ShortcutsDialog.module.css';

/** Every command with an effective keybind, grouped by category (Ctrl+/). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { commands, stores } = useShrike();
  const all = useSyncExternalStore(
    (fn) => commands.subscribe(fn),
    () => commands.all(),
  );
  const overrides = useStore(stores.settings, (s) => s.keybinds);
  const bindings = resolveKeybinds(all, overrides);
  const mac = isMacPlatform();
  const groups = new Map<string, { id: string; title: string; combo: string }[]>();
  for (const command of all) {
    const kb = bindings.get(command.id);
    if (!kb) continue;
    const category = command.category ?? 'Other';
    groups.set(category, [
      ...(groups.get(category) ?? []),
      { id: command.id, title: command.title, combo: formatKeybind(kb, mac) },
    ]);
  }
  // Built-in list keys (not rebindable commands, but worth knowing).
  groups.set('Lists', [
    { id: 'list-move', title: 'Move between items', combo: '↑|↓' },
    { id: 'list-ends', title: 'First / last item', combo: 'Home|End' },
    { id: 'list-menu', title: 'Open item menu', combo: 'Shift+F10' },
    { id: 'list-menu-2', title: 'Open item menu (alternative)', combo: mac ? '⌘↩' : 'Ctrl+Enter' },
  ]);
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Keyboard shortcuts"
      description="Includes your own changes. Rebind any of these in Settings → Keybinds."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              stores.ui.getState().openModal({ type: 'settings', props: { page: 'keybinds' } });
            }}
          >
            Edit shortcuts
          </Button>
        </>
      }
    >
      <div className={styles.groups}>
        {[...groups].map(([category, items]) => (
          <section key={category} className={styles.group}>
            <h3 className={styles.heading}>{category}</h3>
            <dl>
              {items.map((item) => (
                <div key={item.id} className={styles.row}>
                  <dt>{item.title}</dt>
                  <dd className={styles.keys}>
                    {/* "|" separates alternative keys shown side by side. */}
                    {item.combo.split('|').map((combo) => (
                      <Kbd key={combo} combo={combo} />
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Modal>
  );
}
