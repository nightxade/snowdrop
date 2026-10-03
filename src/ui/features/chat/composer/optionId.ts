/** DOM id of suggestion `index` in the autocomplete listbox `listId` (aria-activedescendant). */
export function optionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}
