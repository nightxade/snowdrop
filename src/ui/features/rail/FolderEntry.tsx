import { FolderOpen } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, Ref } from 'react';
import { useStore } from 'zustand';
import { initialsFor } from '@/core/domain';
import type { RailEntry } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { RailTile } from './RailTile';
import { SpaceTile } from './SpaceTile';
import { useSpacesUnread } from './useUnread';
import styles from './FolderEntry.module.css';

type Folder = Extract<RailEntry, { type: 'folder' }>;

export interface FolderEntryProps {
  folder: Folder;
  wrapperRef?: Ref<HTMLDivElement> | undefined;
  wrapperStyle?: CSSProperties | undefined;
  dragHandle?: HTMLAttributes<HTMLButtonElement> | undefined;
  dragging?: boolean;
}

/**
 * A folder of spaces: collapsed it previews up to four spaces in a 2×2 grid
 * and aggregates their unread state; expanded it lists them on a tinted rail
 * segment so it's clear which tiles belong together.
 */
export function FolderEntry({
  folder,
  wrapperRef,
  wrapperStyle,
  dragHandle,
  dragging,
}: FolderEntryProps) {
  const stores = useStores();
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const selectedSpace = useStore(stores.ui, (s) => s.selectedSpace);
  const { hasUnread, mentions } = useSpacesUnread(folder.spaceIds);
  const containsSelected = folder.spaceIds.includes(selectedSpace);
  const toggle = () => {
    stores.spaces.getState().toggleFolder(folder.id);
  };

  if (folder.collapsed) {
    return (
      <RailTile
        label={folder.name}
        selected={containsSelected}
        unread={hasUnread}
        mentions={mentions}
        aria-expanded={false}
        wrapperRef={wrapperRef}
        wrapperStyle={wrapperStyle}
        dragging={dragging ?? false}
        className={styles.collapsed}
        onClick={toggle}
        {...dragHandle}
      >
        <span className={styles.grid} aria-hidden>
          {folder.spaceIds.slice(0, 4).map((id) => {
            const space = spaces[id];
            if (!space) return null;
            return (
              <span
                key={id}
                className={styles.mini}
                style={{ '--tile-hue': `var(--shrike-avatar-${space.hue})` } as CSSProperties}
              >
                {space.emoji ?? initialsFor(space.name).slice(0, 1)}
              </span>
            );
          })}
        </span>
      </RailTile>
    );
  }

  return (
    <div
      ref={wrapperRef}
      style={wrapperStyle}
      className={styles.open}
      data-dragging={dragging ? '' : undefined}
    >
      <RailTile
        label={`${folder.name} (collapse)`}
        aria-expanded
        tone="accent"
        onClick={toggle}
        {...dragHandle}
      >
        <FolderOpen size={22} aria-hidden />
      </RailTile>
      {folder.spaceIds.map((id) => (
        <SpaceTile key={id} spaceId={id} />
      ))}
    </div>
  );
}
