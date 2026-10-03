/**
 * Conversation actions shared by the sidebar context menu, the row hover
 * buttons, the chat header and keyboard commands.
 */
import {
  directConversationId,
  HOUR,
  MINUTE,
  type Contact,
  type ConversationId,
  type MuteState,
} from '@/core/domain';
import { HOME, uiSelectors } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';

export const MUTE_OPTIONS: readonly { id: string; label: string; ms: number | null }[] = [
  { id: '15m', label: 'For 15 minutes', ms: 15 * MINUTE },
  { id: '1h', label: 'For 1 hour', ms: HOUR },
  { id: '8h', label: 'For 8 hours', ms: 8 * HOUR },
  { id: '24h', label: 'For 24 hours', ms: 24 * HOUR },
  { id: 'forever', label: 'Until I turn it back on', ms: null },
];

export function muteState(ms: number | null, now: number): MuteState {
  return ms === null ? true : { until: now + ms };
}

export function openConversation(
  app: AppServices,
  id: ConversationId,
  space: string = app.stores.ui.getState().selectedSpace,
): void {
  app.stores.ui.getState().selectConversation(id, space);
}

/**
 * Opens the direct conversation with a contact, creating a local placeholder
 * if there's none yet (Signal has no "create DM" call: the conversation
 * exists as soon as either side sends; the sync engine replaces the
 * placeholder with the backend's record).
 */
export function openDirectConversation(app: AppServices, contact: Contact): ConversationId {
  const id = directConversationId(contact.id);
  const { conversations, session, ui } = app.stores;
  if (!conversations.getState().byId[id]) {
    const selfId = session.getState().self?.id;
    conversations.getState().upsert({
      id,
      kind: 'direct',
      title: contact.name,
      memberIds: selfId ? [selfId, contact.id] : [contact.id],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    });
  }
  ui.getState().selectConversation(id, HOME);
  return id;
}

export function markRead(app: AppServices, id: ConversationId): void {
  void app.sync.markConversationRead(id);
}

export function archive(app: AppServices, id: ConversationId, archived: boolean): void {
  app.stores.local.getState().setArchived(id, archived);
  if (archived) {
    // Archiving the open conversation shouldn't leave you staring at it.
    const ui = app.stores.ui.getState();
    if (uiSelectors.selectedConversation(ui) === id) {
      const { [ui.selectedSpace]: _closed, ...rest } = ui.selectedConversationBySpace;
      app.stores.ui.setState({ selectedConversationBySpace: rest });
    }
    app.stores.ui.getState().pushToast({
      message: 'Conversation archived. Find it under Archived in Home.',
      kind: 'info',
      source: 'core',
    });
  }
}

export async function copyText(app: AppServices, text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    app.stores.ui
      .getState()
      .pushToast({ message: `Copied ${what}`, kind: 'success', source: 'core' });
  } catch {
    app.stores.ui.getState().pushToast({
      message: `Couldn't copy ${what}: clipboard access was denied`,
      kind: 'error',
      source: 'core',
    });
  }
}

/** Disappearing-message timers offered in the conversation menu (seconds; 0 = off). */
export const TIMER_OPTIONS: readonly { seconds: number; label: string }[] = [
  { seconds: 0, label: 'Off' },
  { seconds: 30, label: '30 seconds' },
  { seconds: 5 * 60, label: '5 minutes' },
  { seconds: 60 * 60, label: '1 hour' },
  { seconds: 8 * 60 * 60, label: '8 hours' },
  { seconds: 24 * 60 * 60, label: '1 day' },
  { seconds: 7 * 24 * 60 * 60, label: '1 week' },
  { seconds: 28 * 24 * 60 * 60, label: '4 weeks' },
];

/**
 * Changes the timer or group name for everyone. The conversation (and the
 * "You set…" line in the timeline) updates when the transport confirms; a
 * failure says so in a toast.
 */
export async function updateConversation(
  app: AppServices,
  id: ConversationId,
  patch: { expireTimerSec?: number; title?: string },
): Promise<boolean> {
  const ok = await app.send.updateConversation(id, patch);
  if (!ok)
    app.stores.ui.getState().pushToast({
      message:
        patch.title !== undefined
          ? 'Couldn’t rename the group. Check the connection and try again.'
          : 'Couldn’t change disappearing messages. Check the connection and try again.',
      kind: 'error',
      source: 'core',
    });
  return ok;
}
