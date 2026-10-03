import { Download, Trash2 } from 'lucide-react';
import { useId, type CSSProperties } from 'react';
import { useStore } from 'zustand';
import { BUILTIN_THEMES, toTheme, type Theme } from '@/core/themes';
import { useStores } from '@/ui/hooks';
import { IconButton } from '@/ui/primitives';
import styles from './themes.module.css';

export function useAllThemes(): { builtin: readonly Theme[]; custom: Theme[] } {
  const stores = useStores();
  const custom = useStore(stores.settings, (s) => s.customThemes);
  return { builtin: BUILTIN_THEMES, custom: custom.map(toTheme) };
}

/**
 * A miniature Snowdrop painted with a theme's own colours: rail, sidebar,
 * two messages and the composer. Built from `theme.preview`, so it shows the
 * theme whatever theme is active.
 */
export function ThemePreview({ theme }: { theme: Theme }) {
  const [rail, chat, text, accent] = theme.preview;
  return (
    <span
      className={styles.preview}
      style={
        {
          '--p-rail': rail,
          '--p-chat': chat,
          '--p-text': text,
          '--p-accent': accent,
        } as CSSProperties
      }
      aria-hidden
    >
      <span className={styles.pRail}>
        <span className={styles.pTile} data-on="" />
        <span className={styles.pTile} />
        <span className={styles.pTile} />
      </span>
      <span className={styles.pSidebar}>
        <span className={styles.pLine} data-w="70" />
        <span className={styles.pRow} data-on="">
          <span className={styles.pLine} data-w="60" />
        </span>
        <span className={styles.pLine} data-w="80" />
        <span className={styles.pLine} data-w="50" />
      </span>
      <span className={styles.pChat}>
        <span className={styles.pMsg}>
          <span className={styles.pAvatar} />
          <span className={styles.pBody}>
            <span className={styles.pName} />
            <span className={styles.pLine} data-w="90" />
            <span className={styles.pLine} data-w="60" />
          </span>
        </span>
        <span className={styles.pMsg}>
          <span className={styles.pAvatar} data-alt="" />
          <span className={styles.pBody}>
            <span className={styles.pName} data-alt="" />
            <span className={styles.pLine} data-w="75" />
          </span>
        </span>
        <span className={styles.pComposer}>
          <span className={styles.pSend} />
        </span>
      </span>
    </span>
  );
}

export interface ThemeCardsProps {
  /** Show export/delete actions on custom themes. */
  manage?: boolean;
  onExport?: (theme: Theme) => void;
  label: string;
}

/** Theme picker: native radios (arrow keys move between themes) styled as preview cards. */
export function ThemeCards({ manage, onExport, label }: ThemeCardsProps) {
  const stores = useStores();
  // One radio group per instance: Appearance and Themes both show cards, and
  // settings search can show both at once.
  const group = useId();
  const themeId = useStore(stores.settings, (s) => s.appearance.themeId);
  const { builtin, custom } = useAllThemes();
  const all = [...builtin, ...custom];
  // An unknown id falls back to Dusk in the engine; reflect that here.
  const active = all.some((t) => t.id === themeId) ? themeId : 'dusk';
  return (
    <div className={styles.cards} role="radiogroup" aria-label={label}>
      {all.map((theme) => {
        const isCustom = custom.includes(theme);
        return (
          <div key={theme.id} className={styles.cardWrap}>
            <label className={styles.card} data-theme-card={theme.id}>
              <input
                type="radio"
                name={group}
                className={styles.radio}
                value={theme.id}
                checked={active === theme.id}
                onChange={() => {
                  stores.settings.getState().update('appearance', { themeId: theme.id });
                }}
              />
              <ThemePreview theme={theme} />
              <span className={styles.cardText}>
                <span className={styles.cardName}>{theme.name}</span>
                <span className={styles.cardKind}>
                  {isCustom ? 'Imported' : theme.kind === 'light' ? 'Light' : 'Dark'}
                </span>
              </span>
            </label>
            {manage && (
              <span className={styles.cardActions}>
                <IconButton
                  size="sm"
                  label={`Export ${theme.name}`}
                  icon={<Download />}
                  onClick={() => onExport?.(theme)}
                />
                {isCustom && (
                  <IconButton
                    size="sm"
                    label={`Delete ${theme.name}`}
                    icon={<Trash2 />}
                    onClick={() => {
                      stores.settings.getState().removeCustomTheme(theme.id);
                    }}
                  />
                )}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
