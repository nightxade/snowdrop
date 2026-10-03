import { FolderOpen } from 'lucide-react';
import type { CSSProperties, HTMLAttributes, Ref } from 'react';
import { useStore } from 'zustand';
import { initialsFor } from '@/core/domain';
import type { RailEntry } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { useFolderMenu } from '@/ui/features/spaces';
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
  /** A dragged space would join this folder. */
  mergeTarget?: boolean;
}

/**
 * A folder of spaces: collapsed it previews up to four spaces in a 2×2 grid
 * and aggregates their unread state; expanded it lists them on a tinted rail
 * segment so it's clear which tiles belong together. Right-click (or
 * Shift+F10) to rename, recolour or dissolve it.
 */
export function FolderEntry({
  folder,
  wrapperRef,
  wrapperStyle,
  dragHandle,
  dragging,
  mergeTarget,
}: FolderEntryProps) {
  const stores = useStores();
  const spaces = useStore(stores.spaces, (s) => s.spaces);
  const selectedSpace = useStore(stores.ui, (s) => s.selectedSpace);
  const { hasUnread, mentions } = useSpacesUnread(folder.spaceIds);
  const menu = useFolderMenu(folder.id);
  const containsSelected = folder.spaceIds.includes(selectedSpace);
  const hue = folder.hue ? `var(--snowdrop-avatar-${folder.hue})` : undefined;
  const toggle = () => {
    stores.spaces.getState().toggleFolder(folder.id);
  };

  if (folder.collapsed) {
    return (
      <RailTile
        label={`${folder.name} folder, ${folder.spaceIds.length} spaces`}
        selected={containsSelected}
        unread={hasUnread}
        mentions={mentions}
        aria-expanded={false}
        wrapperRef={wrapperRef}
        wrapperStyle={wrapperStyle}
        dragging={dragging ?? false}
        className={styles.collapsed}
        data-drop={mergeTarget ? '' : undefined}
        menu={menu}
        {...(hue ? { hue } : {})}
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
                style={{ '--tile-hue': `var(--snowdrop-avatar-${space.hue})` } as CSSProperties}
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
      style={{ ...wrapperStyle, ...(hue ? { '--folder-hue': hue } : {}) }}
      className={styles.open}
      data-dragging={dragging ? '' : undefined}
      data-tinted={hue ? '' : undefined}
      role="group"
      aria-label={`${folder.name} folder`}
    >
      <RailTile
        label={`Collapse ${folder.name} folder`}
        aria-expanded
        tone="accent"
        className={styles.header}
        data-drop={mergeTarget ? '' : undefined}
        menu={menu}
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
