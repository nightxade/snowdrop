import type { CSSProperties } from 'react';
import { useStore } from 'zustand';
import { BUILTIN_THEMES } from '@/core/themes';
import { useStores } from '@/ui/hooks';
import { Modal, Switch } from '@/ui/primitives';
import styles from './SettingsDialog.module.css';

/**
 * Interim settings: theme and demo activity. P4 replaces this with the
 * full-screen settings overlay (PLAN §4.9).
 */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const stores = useStores();
  const themeId = useStore(stores.settings, (s) => s.appearance.themeId);
  const lively = useStore(stores.settings, (s) => s.connection.mockLiveliness);
  const backend = useStore(stores.session, (s) => s.backendKind);
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Settings"
      description="Changes apply immediately. The full settings screen is on its way."
    >
      <div className={styles.body}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Theme</legend>
          <div className={styles.themes}>
            {BUILTIN_THEMES.map((theme) => {
              const [bg, surface, text, accent] = theme.preview;
              return (
                <label key={theme.id} className={styles.theme}>
                  <input
                    type="radio"
                    name="theme"
                    value={theme.id}
                    checked={themeId === theme.id}
                    className={styles.radio}
                    onChange={() => {
                      stores.settings.getState().update('appearance', { themeId: theme.id });
                    }}
                  />
                  <span
                    className={styles.swatch}
                    style={
                      {
                        '--p-bg': bg,
                        '--p-surface': surface,
                        '--p-text': text,
                        '--p-accent': accent,
                      } as CSSProperties
                    }
                    aria-hidden
                  >
                    <span />
                    <span />
                  </span>
                  <span className={styles.themeName}>{theme.name}</span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {backend === 'mock' && (
          <Switch
            label="Simulated activity"
            description="People in the demo keep chatting and typing."
            checked={lively}
            onCheckedChange={(on) => {
              stores.settings.getState().update('connection', { mockLiveliness: on });
            }}
          />
        )}
      </div>
    </Modal>
  );
}
