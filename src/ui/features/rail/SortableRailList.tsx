import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  verticalListSortingStrategy,
  type SortingStrategy,
} from '@dnd-kit/sortable';
import { useMemo, useRef, useState } from 'react';
import type { RailEntry } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { canMerge, isMergeDrop } from './railDrop';
import { railEntryKey } from './railEntryKey';
import { RailDragContext } from './RailDragContext';
import { SortableRailEntry } from './SortableRailEntry';

const idOf = (key: string) => key.slice(key.indexOf(':') + 1);

/**
 * The draggable part of the rail. Loaded lazily: dnd-kit isn't needed to paint.
 * Dragging a tile onto the edge of another reorders; onto its middle makes a
 * folder (or joins the folder). While a merge is pending, tiles stop shifting
 * so the target stays put under the pointer.
 */
export function SortableRailList({ rail }: { rail: readonly RailEntry[] }) {
  const stores = useStores();
  // A small distance keeps clicks as clicks; only a deliberate drag reorders.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const keys = rail.map(railEntryKey);
  const [mergeTarget, setMergeTarget] = useState<string | null>(null);
  const merging = useRef<string | null>(null);

  const strategy = useMemo<SortingStrategy>(
    () => (args) => (merging.current ? null : verticalListSortingStrategy(args)),
    [],
  );

  const setMerge = (key: string | null) => {
    if (merging.current === key) return;
    merging.current = key;
    setMergeTarget(key);
  };

  const onDragMove = ({ active, over }: DragMoveEvent) => {
    const a = String(active.id);
    const o = over ? String(over.id) : null;
    const merge =
      o !== null &&
      canMerge(a, o) &&
      isMergeDrop(active.rect.current.translated, over?.rect ?? null);
    setMerge(merge ? o : null);
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const target = merging.current;
    setMerge(null);
    const a = String(active.id);
    if (target) {
      const store = stores.spaces.getState();
      const targetEntry = rail.find((e) => railEntryKey(e) === target);
      const targetSpace =
        targetEntry?.type === 'folder' ? targetEntry.spaceIds[0] : targetEntry?.id;
      if (targetSpace) store.createFolder(targetSpace, idOf(a));
      return;
    }
    if (!over || active.id === over.id) return;
    const from = keys.indexOf(a);
    const to = keys.indexOf(String(over.id));
    if (from !== -1 && to !== -1) stores.spaces.getState().moveRailEntry(from, to);
  };

  return (
    <RailDragContext value={mergeTarget}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        modifiers={[restrictToVerticalAxis]}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setMerge(null);
        }}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              'Drag to reorder, or drop onto another space to make a folder. Keyboard: use the tile’s menu (Shift+F10).',
          },
        }}
      >
        <SortableContext items={keys} strategy={strategy}>
          {rail.map((entry) => (
            <SortableRailEntry key={railEntryKey(entry)} id={railEntryKey(entry)} entry={entry} />
          ))}
        </SortableContext>
      </DndContext>
    </RailDragContext>
  );
}
