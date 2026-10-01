import { useStore } from 'zustand';
import { initialsFor } from '@/core/domain';
import { uiSelectors, type SpaceId } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { useSpaceMenu } from '@/ui/features/spaces';
import { RailTile, type RailTileProps } from './RailTile';
import { useSpacesUnread } from './useUnread';
import styles from './SpaceTile.module.css';

export interface SpaceTileProps extends Omit<
  RailTileProps,
  'label' | 'children' | 'selected' | 'unread' | 'mentions' | 'hue'
> {
  spaceId: SpaceId;
}

export function SpaceTile({ spaceId, ...rest }: SpaceTileProps) {
  const stores = useStores();
  const space = useStore(stores.spaces, (s) => s.spaces[spaceId]);
  const selected = useStore(stores.ui, (s) => uiSelectors.selectedSpace(s) === spaceId);
  const { hasUnread, mentions } = useSpacesUnread([spaceId]);
  const menu = useSpaceMenu(spaceId);
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
