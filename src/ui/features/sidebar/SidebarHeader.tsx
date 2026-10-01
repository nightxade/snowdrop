import { ChevronDown, Search } from 'lucide-react';
import { useStore } from 'zustand';
import { CoreCommand } from '@/core/commands';
import { HOME, uiSelectors } from '@/core/stores';
import { useShrike, useKeybindLabel } from '@/ui/hooks';
import { useSpaceMenu } from '@/ui/features/spaces';
import { DropdownMenu, Tooltip } from '@/ui/primitives';
import styles from './SidebarHeader.module.css';

export function SidebarHeader() {
  const { stores } = useShrike();
  const space = useStore(stores.ui, uiSelectors.selectedSpace);
  return (
    <header className={styles.header} data-shrike="sidebar-header">
      {space === HOME ? <FindButton /> : <SpaceTitle spaceId={space} />}
    </header>
  );
}

function FindButton() {
  const { commands } = useShrike();
  const shortcut = useKeybindLabel(CoreCommand.QuickSwitcher);
  // The label needs the full width at 248px, so the shortcut lives in the tooltip.
  return (
    <Tooltip label="Quick switcher" side="bottom" {...(shortcut ? { shortcut } : {})}>
      <button
        type="button"
        className={styles.find}
        onClick={() => {
          void commands.execute(CoreCommand.QuickSwitcher);
        }}
      >
        <Search size={14} aria-hidden className={styles.findIcon} />
        <span className={styles.findText}>Find or start a conversation</span>
      </button>
    </Tooltip>
  );
}

function SpaceTitle({ spaceId }: { spaceId: string }) {
  const { stores } = useShrike();
  const space = useStore(stores.spaces, (s) => s.spaces[spaceId]);
  const menu = useSpaceMenu(spaceId);
  if (!space) return null;
  return (
    <DropdownMenu entries={menu} align="start" label={`${space.name} options`}>
      <button type="button" className={styles.spaceButton}>
        {space.emoji && (
          <span className={styles.spaceEmoji} aria-hidden>
            {space.emoji}
          </span>
        )}
        <span className={styles.spaceName}>{space.name}</span>
        <ChevronDown size={18} className={styles.chevron} aria-hidden />
      </button>
    </DropdownMenu>
  );
}
