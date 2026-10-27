import type { Contact, ConversationId } from '@/core/domain';
import type { AppServices } from '@/ui/hooks';

/** Whether "View safety number" can be offered for this person (not yourself, and the backend has them). */
export function canViewSafetyNumber(app: AppServices, contact: Pick<Contact, 'isSelf'>): boolean {
  return app.identity.available && contact.isSelf !== true;
}

/**
 * Opens the safety number viewer for a person. Waits a frame so the menu or
 * popover that asked has closed and handed focus back first.
 */
export function openSafetyNumber(app: AppServices, contactId: string): void {
  requestAnimationFrame(() => {
    app.stores.ui.getState().openModal({ type: 'safetyNumber', props: { contactId } });
  });
}

/** Reopens the "Safety Number Changes" dialog for a message a changed safety number stopped. */
export function openSafetyReview(
  app: AppServices,
  conversationId: ConversationId,
  nonce: string,
  contactIds: readonly string[],
): void {
  requestAnimationFrame(() => {
    app.stores.ui
      .getState()
      .openModal({ type: 'safetyNumberChange', props: { conversationId, nonce, contactIds } });
  });
}
