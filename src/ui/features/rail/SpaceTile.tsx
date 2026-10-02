import { useStore } from 'zustand';
import { initialsFor } from '@/core/domain';
import { uiSelectors, type SpaceId } from '@/core/stores';
import type { ConversationId } from '@/core/domain';
import { useConversationDrop, useStores } from '@/ui/hooks';
import { useSpaceMenu } from '@/ui/features/spaces';
import { RailTile, type RailTileProps } from './RailTile';
import { useSpacesUnread } from './useUnread';
import styles from './SpaceTile.module.css';

export interface SpaceTileProps extends Omit<
  RailTileProps,
  'label' | 'children' | 'selected' | 'unread' | 'mentions' | 'hue'
> {
  spaceId: SpaceId;
  /** A dragged space would merge into this tile (folder drop ring). */
  mergeTarget?: boolean;
}

export function SpaceTile({ spaceId, mergeTarget, className, ...rest }: SpaceTileProps) {
  const stores = useStores();
  const space = useStore(stores.spaces, (s) => s.spaces[spaceId]);
  const selected = useStore(stores.ui, (s) => uiSelectors.selectedSpace(s) === spaceId);
  const { hasUnread, mentions } = useSpacesUnread([spaceId]);
  const menu = useSpaceMenu(spaceId);
  // Drop a conversation from the sidebar onto the tile to move it into this space.
  const drop = useConversationDrop((id) => {
    stores.spaces.getState().assign(id as ConversationId, spaceId);
    stores.ui.getState().pushToast({
      message: `Moved to ${stores.spaces.getState().spaces[spaceId]?.name ?? 'space'}`,
      kind: 'success',
      source: 'core',
    });
  });
  if (!space) return null;
  return (
    <RailTile
      label={space.name}
      selected={selected}
      unread={hasUnread}
      mentions={mentions}
      hue={`var(--shrike-avatar-${space.hue})`}
      menu={menu}
      onClick={() => {
        stores.ui.getState().selectSpace(spaceId);
      }}
      className={[styles.target, className].filter(Boolean).join(' ')}
      data-drop={drop.active || mergeTarget ? '' : undefined}
      {...drop.handlers}
      {...rest}
    >
      {space.emoji ? (
        <span className={styles.emoji}>{space.emoji}</span>
      ) : (
        <span className={styles.initials}>{initialsFor(space.name)}</span>
      )}
    </RailTile>
  );
}
