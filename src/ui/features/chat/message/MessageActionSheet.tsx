import { Drawer, type MenuEntry } from '@/ui/primitives';
import styles from './MessageActionSheet.module.css';

/**
 * Touch: a long-press opens the message's actions as a bottom sheet — the
 * same entries as the context menu, with large targets. Submenus (Add
 * reaction) are laid out inline: their items as a row of chips.
 */
export function MessageActionSheet({
  open,
  onOpenChange,
  entries,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: () => readonly MenuEntry[];
}) {
  const close = () => {
    onOpenChange(false);
  };
  return (
    <Drawer side="bottom" open={open} onOpenChange={onOpenChange} label="Message actions">
      {open && (
        <div className={styles.sheet} data-shrike="message-action-sheet">
          <span className={styles.grip} aria-hidden />
          {entries().map((entry) => {
            switch (entry.kind) {
              case 'separator':
                return <hr key={entry.id} className={styles.separator} />;
              case 'label':
                return (
                  <p key={entry.id} className={styles.label}>
                    {entry.label}
                  </p>
                );
              case 'submenu':
                return (
                  <div
                    key={entry.id}
                    className={styles.chips}
                    role="group"
                    aria-label={entry.label}
                  >
                    {entry.items.flatMap((item) =>
                      item.kind === 'item'
                        ? [
                            <button
                              key={item.id}
                              type="button"
                              className={styles.chip}
                              onClick={() => {
                                close();
                                item.onSelect();
                              }}
                            >
                              {item.label}
                            </button>,
                          ]
                        : [],
                    )}
                  </div>
                );
              case 'item':
              case 'check':
                return (
                  <button
                    key={entry.id}
                    type="button"
                    className={styles.item}
                    data-danger={entry.kind === 'item' && entry.danger ? '' : undefined}
                    disabled={entry.kind === 'item' ? (entry.disabled ?? false) : false}
                    onClick={() => {
                      close();
                      entry.onSelect();
                    }}
                  >
                    {entry.icon && (
                      <span className={styles.icon} aria-hidden>
                        {entry.icon}
                      </span>
                    )}
                    {entry.label}
                  </button>
                );
            }
          })}
        </div>
      )}
    </Drawer>
  );
}
