import { useSyncExternalStore } from 'react';
import { modeLabel, type Mode } from './engine/engine';
import type { ModeStore } from './modeStore';
import styles from './vim.module.css';

export interface StatusModePillDeps {
  modes: ModeStore;
  /** The composer whose mode this reflects (the open conversation's), or null. */
  currentSurface: () => string | null;
  subscribeOptions: (fn: () => void) => () => void;
  composerEnabled: () => boolean;
  startMode: () => Mode;
}

/**
 * The TUI shell status line's mode item (`status.items`): the same
 * NORMAL/INSERT/VISUAL as the composer's mode pill (`ModePill.tsx`), for the
 * currently open conversation, so it's visible even when the composer itself
 * is scrolled out of view or unfocused.
 */
export function makeStatusModePill(deps: StatusModePillDeps) {
  return function VimStatusModePill() {
    const surface = deps.currentSurface();
    const snapshot = useSyncExternalStore(deps.modes.subscribe, () =>
      surface ? deps.modes.get(surface) : null,
    );
    const enabled = useSyncExternalStore(deps.subscribeOptions, deps.composerEnabled);
    const start = useSyncExternalStore(deps.subscribeOptions, deps.startMode);
    if (!enabled || !surface) return null;
    const mode = snapshot?.mode ?? start;
    return (
      <span className={styles.pill} data-vim-mode={mode} data-snowdrop="vim-mode">
        {modeLabel(mode)}
      </span>
    );
  };
}
