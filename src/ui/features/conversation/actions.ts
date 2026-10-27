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
import { followConversationOpenFocus, type AppServices } from '@/ui/hooks';

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

export interface OpenConversationOptions {
  space?: string;
}

export function openConversation(
  app: AppServices,
  id: ConversationId,
  options: OpenConversationOptions = {},
): void {
  const space = options.space ?? app.stores.ui.getState().selectedSpace;
  app.stores.ui.getState().selectConversation(id, space);
  // A no-op unless a plugin's focus policy is active (Vim mode): otherwise
  // today's behaviour — a click doesn't move focus — is unchanged.
  followConversationOpenFocus(id);
}

/**
 * The direct conversation with a contact, creating a local placeholder if
 * there's none yet (Signal has no "create DM" call: the conversation exists
 * as soon as either side sends; the sync engine replaces the placeholder with
 * the backend's record). Opens nothing.
 */
export function ensureDirectConversation(app: AppServices, contact: Contact): ConversationId {
  const id = directConversationId(contact.id);
  const { conversations, session } = app.stores;
  if (!conversations.getState().byId[id]) {
    const selfId = session.getState().self?.id;
    const isSelf = contact.isSelf === true || contact.id === selfId;
    conversations.getState().upsert({
      id,
      kind: 'direct',
      title: isSelf ? 'Note to Self' : contact.name,
      memberIds: selfId && !isSelf ? [selfId, contact.id] : [contact.id],
      adminIds: [],
      expireTimerSec: 0,
      lastActivityAt: 0,
    });
    // The user's own move, not someone writing to them: no request to answer.
    app.stores.local.getState().markAccepted(id, Date.now());
  }
  return id;
}

/** Opens the direct conversation with a contact (see `ensureDirectConversation`). */
export function openDirectConversation(app: AppServices, contact: Contact): ConversationId {
  const id = ensureDirectConversation(app, contact);
  app.stores.ui.getState().selectConversation(id, HOME);
  return id;
}

export function markRead(app: AppServices, id: ConversationId): void {
  void app.sync.markConversationRead(id);
}

/**
 * Flags a conversation unread by hand. Device-local, so nothing is sent: no
 * receipt, no sync. It stays marked, even while open, until the conversation
 * is next opened or marked read.
 */
export function markUnread(app: AppServices, id: ConversationId): void {
  app.stores.local.getState().setMarkedUnread(id, true);
  app.stores.ui
    .getState()
    .pushToast({ message: 'Conversation marked as unread', kind: 'info', source: 'core' });
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
      message: 'Conversation archived. Find it under Archived chats at the bottom of the list.',
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

/**
 * Opens the block / unblock confirmation (`BlockDialog`). Waits a frame so the
 * menu or popover that asked has closed and handed focus back first.
 */
export function openBlockDialog(app: AppServices, id: ConversationId, unblock: boolean): void {
  requestAnimationFrame(() => {
    app.stores.ui
      .getState()
      .openModal({ type: 'blockConversation', props: { conversationId: id, unblock } });
  });
}

/** The group dialogs `ModalHost` knows (they live in the groups feature, loaded when first opened). */
export type GroupModalType =
  | 'newGroup'
  | 'editGroup'
  | 'addMembers'
  | 'groupLink'
  | 'groupPermissions'
  | 'leaveGroup'
  | 'groupMemberAction';

/** What a member-action dialog asks the user to confirm. */
export type GroupMemberAction =
  'remove' | 'make-admin' | 'remove-admin' | 'approve' | 'deny' | 'revoke';

/**
 * Opens a group dialog. Waits a frame so the menu or popover that asked has
 * closed and handed focus back first, and the dialog returns focus there.
 */
export function openGroupModal(
  app: AppServices,
  type: GroupModalType,
  props?: Record<string, unknown>,
): void {
  requestAnimationFrame(() => {
    app.stores.ui.getState().openModal({ type, ...(props ? { props } : {}) });
  });
}
