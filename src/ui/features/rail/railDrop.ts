/**
 * Pure geometry for rail drags: is the dragged tile hovering the *middle* of
 * another tile (merge into a folder) or its edge (reorder)? Exported for tests.
 */
export interface Rect {
  top: number;
  height: number;
}

/** Middle 50% of the target merges; the outer quarters reorder. */
export const MERGE_ZONE = 0.5;

export function isMergeDrop(dragged: Rect | null, target: Rect | null): boolean {
  if (!dragged || !target) return false;
  const center = dragged.top + dragged.height / 2;
  const half = (target.height * MERGE_ZONE) / 2;
  const mid = target.top + target.height / 2;
  return center >= mid - half && center <= mid + half;
}

/** Only a space can be dropped into something; folders don't nest. */
export function canMerge(activeKey: string, overKey: string): boolean {
  return activeKey !== overKey && activeKey.startsWith('space:');
}
