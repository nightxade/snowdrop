/**
 * Where a dragged row lands in a category: pure, so the off-by-one rules are
 * tested. Positions are computed against the *rendered* rows (collapsed
 * categories hide some) and mapped back to the category's full order.
 */

/** Index among rendered rows: before the first row whose middle is below the pointer. */
export function renderedInsertIndex(rowMiddles: readonly number[], pointerY: number): number {
  const i = rowMiddles.findIndex((mid) => pointerY < mid);
  return i === -1 ? rowMiddles.length : i;
}

/**
 * Maps an insertion point among rendered ids to the store index for
 * `moveConversation` (which removes the row first, then inserts).
 */
export function storeInsertIndex(
  fullIds: readonly string[],
  renderedIds: readonly string[],
  renderedIndex: number,
  draggedId: string,
): number {
  const before = renderedIds[renderedIndex];
  let index = before === undefined ? fullIds.length : fullIds.indexOf(before);
  if (index === -1) index = fullIds.length;
  const from = fullIds.indexOf(draggedId);
  // Removing the dragged row first shifts everything after it up by one.
  if (from !== -1 && from < index) index -= 1;
  return index;
}
