import { ArrowDown } from 'lucide-react';
import { CoreCommand } from '@/core/commands';
import { useKeybindLabel, useShellStyle } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './Overlays.module.css';

/**
 * Floating pill at the bottom when you're a screen or more away from the
 * present (standard shell). In TUI it's a small bordered chip, so the hook
 * lives on the button itself, not the centring wrapper around it — the
 * wrapper is full-width (`left: 0; right: 0`) to center the pill, and a TUI
 * rule keyed on the wrapper (as `data-snowdrop='jump-to-present'` used to be)
 * turns that whole width into a bordered bar. overlays.css repositions the
 * wrapper via `:has()` instead.
 */
export function JumpToPresent({
  visible,
  count,
  onJump,
}: {
  visible: boolean;
  count: number;
  onJump: () => void;
}) {
  const shortcut = useKeybindLabel(CoreCommand.JumpToPresent);
  const tui = useShellStyle();
  if (!visible) return null;
  const label =
    count > 0
      ? `${count > 99 ? '99+' : count} new message${count === 1 ? '' : 's'}`
      : 'Jump to latest';
  return (
    <div className={styles.jumpWrap}>
      <Tooltip label="Jump to latest" {...(shortcut ? { shortcut } : {})}>
        <button
          type="button"
          className={styles.jump}
          data-snowdrop="jump-to-present"
          data-new={count > 0 ? '' : undefined}
          onClick={onJump}
        >
          {tui ? (
            <span>{`[${count > 0 ? `${count > 99 ? '99+' : count} new` : 'latest'} ↓]`}</span>
          ) : (
            <>
              <span>{label}</span>
              <ArrowDown size={16} aria-hidden />
            </>
          )}
        </button>
      </Tooltip>
    </div>
  );
}
