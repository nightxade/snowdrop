import { useSyncExternalStore } from 'react';
import { useStore } from 'zustand';
import { formatKeybind, isMacPlatform, resolveKeybinds } from '@/core/commands';
import { useSnowdrop } from '@/ui/hooks';
import { Button, Kbd, Modal, VisuallyHidden } from '@/ui/primitives';
import styles from './ShortcutsDialog.module.css';

/**
 * Every command with an effective keybind, grouped by category (Ctrl+/),
 * plus the help of installed key layers (Vim mode).
 */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const { commands, stores, registries } = useSnowdrop();
  const all = useSyncExternalStore(
    (fn) => commands.subscribe(fn),
    () => commands.all(),
  );
  const layers = useSyncExternalStore(
    (fn) => registries.keyLayers.subscribe(fn),
    () => registries.keyLayers.layers(),
  );
  const overrides = useStore(stores.settings, (s) => s.keybinds);
  const bindings = resolveKeybinds(all, overrides);
  const mac = isMacPlatform();
  const groups = new Map<
    string,
    { id: string; title: string; combo: string; sequence?: boolean }[]
  >();
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
  // Layer help: keys are sequences ("g g", "Space s"); spaces separate keycaps.
  for (const { layer } of layers)
    for (const group of layer.help ?? [])
      groups.set(
        group.title,
        group.items.map((item, i) => ({
          id: `${layer.id}-${group.title}-${i}`,
          title: item.title,
          combo: item.keys,
          sequence: true,
        })),
      );
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
      {/* Focusable so the scrolling sheet can be read with the keyboard alone. */}
      <div className={styles.groups} tabIndex={0} role="region" aria-label="Shortcuts">
        {[...groups].map(([category, items]) => (
          <section key={category} className={styles.group}>
            <h3 className={styles.heading}>{category}</h3>
            <dl>
              {items.map((item) => (
                <div key={item.id} className={styles.row}>
                  <dt>{item.title}</dt>
                  <dd className={styles.keys}>
                    {/* "|" separates alternative keys shown side by side. */}
                    {item.combo.split('|').map((combo, n) =>
                      item.sequence ? (
                        <span key={combo} className={styles.sequence}>
                          {/* Alternatives get a slash so "g g / G" can't read as one sequence. */}
                          {n > 0 && (
                            <span className={styles.or}>
                              <span aria-hidden>/</span>
                              <VisuallyHidden>or</VisuallyHidden>
                            </span>
                          )}
                          {combo.split(' ').map((k, i) => (
                            <Kbd key={`${k}-${i}`} combo={k} />
                          ))}
                        </span>
                      ) : (
                        <Kbd key={combo} combo={combo} />
                      ),
                    )}
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
