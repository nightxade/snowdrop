import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Tooltip, VisuallyHidden } from '@/ui/primitives';
import { modeLabel, type Mode } from './engine/engine';
import type { ModeStore } from './modeStore';
import styles from './vim.module.css';

const SPOKEN: Record<Mode, string> = {
  normal: 'Normal mode',
  insert: 'Insert mode',
  visual: 'Visual mode',
  'visual-line': 'Visual line mode',
};

export interface ModePillDeps {
  modes: ModeStore;
  /** Whether composer modal editing is on and which mode a fresh composer starts in. */
  subscribeOptions: (fn: () => void) => () => void;
  composerEnabled: () => boolean;
  startMode: () => Mode;
}

/**
 * The composer's mode indicator ("NORMAL", "INSERT", "VISUAL") with any
 * pending keys, like Vim's showcmd. Mode changes (not keys) are announced
 * politely to screen readers.
 */
export function makeModePill(deps: ModePillDeps) {
  return function VimModePill({ conversationId }: { conversationId: string }) {
    const snapshot = useSyncExternalStore(deps.modes.subscribe, () =>
      deps.modes.get(conversationId),
    );
    const navPending = useSyncExternalStore(deps.modes.subscribe, () => deps.modes.nav);
    const enabled = useSyncExternalStore(deps.subscribeOptions, deps.composerEnabled);
    const start = useSyncExternalStore(deps.subscribeOptions, deps.startMode);
    const mode = snapshot.mode ?? start;
    const announcement = useModeAnnouncement(mode);
    if (!enabled) return null;
    const pending = snapshot.pending || navPending;
    return (
      <>
        <Tooltip label="Vim mode · Esc for Normal mode, ? for keys" delayMs={500}>
          <span className={styles.pill} data-vim-mode={mode} data-shrike="vim-mode">
            {modeLabel(mode)}
            {pending && (
              <span className={styles.pending} aria-hidden>
                {pending.replace(/ /gu, '␣')}
              </span>
            )}
          </span>
        </Tooltip>
        <VisuallyHidden role="status">{announcement}</VisuallyHidden>
      </>
    );
  };
}

/** Text for the live region: empty at first, then the new mode after each change. */
function useModeAnnouncement(mode: Mode): string {
  const [text, setText] = useState('');
  const previous = useRef(mode);
  useEffect(() => {
    if (previous.current === mode) return;
    previous.current = mode;
    setText(SPOKEN[mode]);
  }, [mode]);
  return text;
}
