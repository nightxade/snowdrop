import { lazy, Suspense } from 'react';
import { Plus } from 'lucide-react';
import { useStore } from 'zustand';
import { HOME, spacesSelectors } from '@/core/stores';
import type { ConversationId } from '@/core/domain';
import { useConversationDrop, useRovingFocus, useStores } from '@/ui/hooks';
import { Scroller, SnowdropMark } from '@/ui/primitives';
import { HealthDot } from './HealthDot';
import { RailTile } from './RailTile';
import { FolderEntry } from './FolderEntry';
import { railEntryKey } from './railEntryKey';
import { SpaceTile } from './SpaceTile';
import { useHomeUnread } from './useUnread';
import styles from './Rail.module.css';

// dnd-kit loads after first paint; until then the same tiles render without drag.
const SortableRailList = lazy(() =>
  import('./SortableRailList').then((m) => ({ default: m.SortableRailList })),
);

export function Rail() {
  const stores = useStores();
  const rail = useStore(stores.spaces, spacesSelectors.rail);
  const selectedSpace = useStore(stores.ui, (s) => s.selectedSpace);
  const home = useHomeUnread();
  const onKeyDown = useRovingFocus('vertical');
  // Dropping a conversation on Home takes it out of its space.
  const homeDrop = useConversationDrop((id) => {
    stores.spaces.getState().unassign(id as ConversationId);
    stores.ui
      .getState()
      .pushToast({ message: 'Moved back to Home', kind: 'success', source: 'core' });
  });

  return (
    <nav className={styles.rail} aria-label="Spaces" data-snowdrop="rail" data-pane-title="spaces">
      <Scroller scrollbar="none" className={styles.scroller} onKeyDown={onKeyDown}>
        <RailTile
          label="Home"
          tone="accent"
          selected={selectedSpace === HOME}
          unread={home.hasUnread}
          mentions={home.mentions}
          className={homeDrop.active ? styles.dropTarget : undefined}
          {...homeDrop.handlers}
          onClick={() => {
            stores.ui.getState().selectSpace(HOME);
          }}
        >
          <SnowdropMark size={26} />
        </RailTile>
        <div className={styles.separator} role="separator" />
        <Suspense
          fallback={rail.map((entry) =>
            entry.type === 'folder' ? (
              <FolderEntry key={railEntryKey(entry)} folder={entry} />
            ) : (
              <SpaceTile key={railEntryKey(entry)} spaceId={entry.id} />
            ),
          )}
        >
          <SortableRailList rail={rail} />
        </Suspense>
        <RailTile
          label="Create a space"
          tone="quiet"
          onClick={() => {
            stores.ui.getState().openModal({ type: 'createSpace' });
          }}
        >
          <Plus size={22} aria-hidden />
        </RailTile>
      </Scroller>
      <HealthDot />
    </nav>
  );
}
