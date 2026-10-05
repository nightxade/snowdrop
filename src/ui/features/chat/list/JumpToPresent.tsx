import { ArrowDown } from 'lucide-react';
import { CoreCommand } from '@/core/commands';
import { useKeybindLabel } from '@/ui/hooks';
import { Tooltip } from '@/ui/primitives';
import styles from './Overlays.module.css';

/** Floating pill at the bottom when you're a screen or more away from the present. */
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
  if (!visible) return null;
  const label =
    count > 0
      ? `${count > 99 ? '99+' : count} new message${count === 1 ? '' : 's'}`
      : 'Jump to latest';
  return (
    <div className={styles.jumpWrap} data-snowdrop="jump-to-present">
      <Tooltip label="Jump to latest" {...(shortcut ? { shortcut } : {})}>
        <button
          type="button"
          className={styles.jump}
          data-new={count > 0 ? '' : undefined}
          onClick={onJump}
        >
          <span>{label}</span>
          <ArrowDown size={16} aria-hidden />
        </button>
      </Tooltip>
    </div>
  );
}
