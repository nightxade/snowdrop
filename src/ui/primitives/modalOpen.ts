/**
 * Whether a modal dialog (a Modal, full-screen dialog or lightbox, not a drawer or popover) is
 * open. The app behind it is not the user's to act on: the global key commands stand down.
 */
export function modalDialogOpen(doc: Document = document): boolean {
  return doc.querySelector('[data-modal-dialog][data-state="open"]') !== null;
}
