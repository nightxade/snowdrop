/**
 * Message actions shared by the hover bar, the context menu, reaction pills
 * and keyboard shortcuts, so every entry point behaves the same.
 */
import { bodyToPlainText, isPendingMessageId, type Message } from '@/core/domain';
import { selectMessageRequestState, UNKNOWN_CONTACT_NAME } from '@/core/stores';
import type { AppServices } from '@/ui/hooks';
import { copyText } from '@/ui/features/conversation';
import type { ChatController } from '../ChatController';
import { toMarkdown } from '../lib/toMarkdown';

export function nameResolver(app: AppServices): (id: string) => string {
  const contacts = app.stores.contacts.getState().byId;
  return (id) => contacts[id]?.name ?? UNKNOWN_CONTACT_NAME;
}

function report(app: AppServices, message: string): void {
  app.stores.ui.getState().pushToast({ message, kind: 'error', source: 'core' });
}

export function reply(app: AppServices, chat: ChatController, m: Message): void {
  app.stores.ui.getState().setReplyTo(m.conversationId, m.id);
  chat.focusComposer();
}

export function startEdit(app: AppServices, m: Message): void {
  app.stores.ui.getState().setEditing({ conversationId: m.conversationId, messageId: m.id });
}

/** Adds (or switches to) a reaction; Signal allows one per person. */
export function react(app: AppServices, m: Message, emoji: string): void {
  app.stores.local.getState().noteReactionUsed(emoji);
  const selfId = app.stores.session.getState().self?.id;
  const mine = m.reactions.find((r) => r.authorId === selfId);
  if (mine?.emoji === emoji) return;
  void app.send.react(m.conversationId, m, emoji);
}

export function toggleReaction(app: AppServices, m: Message, emoji: string): void {
  const selfId = app.stores.session.getState().self?.id;
  const adding = !m.reactions.some((r) => r.authorId === selfId && r.emoji === emoji);
  if (adding) app.stores.local.getState().noteReactionUsed(emoji);
  void app.send.toggleReaction(m.conversationId, m, emoji);
}

export function copyMessageText(app: AppServices, m: Message): void {
  void copyText(app, bodyToPlainText(m.body, m.ranges, nameResolver(app)), 'message text');
}

export function copyMarkdown(app: AppServices, m: Message): void {
  void copyText(app, toMarkdown(m.body, m.ranges, nameResolver(app)).text, 'Markdown');
}

export function copyMessageId(app: AppServices, m: Message): void {
  void copyText(app, m.id, 'message ID');
}

export function setPinned(app: AppServices, m: Message, pin: boolean): void {
  void app.send.pin(m.conversationId, m, pin).then((ok) => {
    if (ok)
      app.stores.ui.getState().pushToast({
        message: pin ? 'Message pinned' : 'Message unpinned',
        kind: 'success',
        source: 'core',
      });
  });
}

export function deleteForEveryone(app: AppServices, m: Message): void {
  void app.send.deleteForEveryone(m.conversationId, m).then((ok) => {
    if (!ok) report(app, "Couldn't delete that message");
  });
}

export function deleteForMe(app: AppServices, m: Message): void {
  void app.send.deleteForMe(m.conversationId, m);
}

export function adminDelete(app: AppServices, m: Message): void {
  void app.send.adminDelete(m.conversationId, m).then((ok) => {
    if (!ok) report(app, "Couldn't delete that message");
  });
}

export function retry(app: AppServices, m: Message): void {
  if (m.nonce) void app.send.retry(m.conversationId, m.nonce);
}

export function discard(app: AppServices, m: Message): void {
  if (m.nonce) void app.send.discard(m.conversationId, m.nonce);
}

export interface MessagePermissions {
  own: boolean;
  failed: boolean;
  pending: boolean;
  canEdit: boolean;
  canReact: boolean;
  canAdminDelete: boolean;
  canPin: boolean;
}

export function permissionsFor(app: AppServices, m: Message): MessagePermissions {
  const selfId = app.stores.session.getState().self?.id ?? null;
  const own = m.authorId === selfId;
  const failed = m.status === 'failed' && own;
  const pending = isPendingMessageId(m.id);
  const conversation = app.stores.conversations.getState().byId[m.conversationId];
  const admin = selfId !== null && (conversation?.adminIds.includes(selfId) ?? false);
  const normal = m.kind === 'normal' && !m.deleted;
  const caps = app.send.capabilities;
  // Reacting, replying and pinning all send something to the other side: not
  // before the user has accepted them (a message request is read-only).
  const accepted = selectMessageRequestState(app.stores, m.conversationId) === 'accepted';
  return {
    own,
    failed,
    pending,
    canEdit: own && normal,
    canReact: normal && !failed && accepted,
    canAdminDelete: normal && !own && admin && conversation?.kind === 'group' && caps.adminDelete,
    canPin: normal && !failed && accepted && caps.pin,
  };
}
