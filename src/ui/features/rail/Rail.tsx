import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Plus } from 'lucide-react';
import { useStore } from 'zustand';
import { HOME, spacesSelectors } from '@/core/stores';
import { useRovingFocus, useStores } from '@/ui/hooks';
import { HearthMark, Scroller } from '@/ui/primitives';
import { HealthDot } from './HealthDot';
import { RailTile } from './RailTile';
import { SortableRailEntry } from './SortableRailEntry';
import { useHomeUnread } from './useUnread';
import styles from './Rail.module.css';

export const railEntryKey = (entry: { type: string; id: string }) => `${entry.type}:${entry.id}`;

export function Rail() {
  const stores = useStores();
  const rail = useStore(stores.spaces, spacesSelectors.rail);
  const selectedSpace = useStore(stores.ui, (s) => s.selectedSpace);
  const home = useHomeUnread();
  const onKeyDown = useRovingFocus('vertical');
  // A small distance keeps clicks as clicks; only a deliberate drag reorders.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const keys = rail.map(railEntryKey);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(String(active.id));
    const to = keys.indexOf(String(over.id));
    if (from !== -1 && to !== -1) stores.spaces.getState().moveRailEntry(from, to);
  };

  return (
    <nav className={styles.rail} aria-label="Spaces" data-hearth="rail">
      <Scroller scrollbar="none" className={styles.scroller} onKeyDown={onKeyDown}>
        <RailTile
          label="Home"
          tone="accent"
          selected={selectedSpace === HOME}
          unread={home.hasUnread}
          mentions={home.mentions}
          onClick={() => {
            stores.ui.getState().selectSpace(HOME);
          }}
        >
          <HearthMark size={26} />
        </RailTile>
        <div className={styles.separator} role="separator" />
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={keys} strategy={verticalListSortingStrategy}>
            {rail.map((entry) => (
              <SortableRailEntry key={railEntryKey(entry)} id={railEntryKey(entry)} entry={entry} />
            ))}
          </SortableContext>
        </DndContext>
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
