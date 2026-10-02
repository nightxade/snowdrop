import { createContext, use } from 'react';

/** Rail key of the tile a dragged space would merge into (shown as a drop ring). */
export const RailDragContext = createContext<string | null>(null);

export function useMergeTarget(): string | null {
  return use(RailDragContext);
}
