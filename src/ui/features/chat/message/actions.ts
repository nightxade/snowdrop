/**
 * Message actions shared by the hover bar, the context menu, reaction pills
 * and keyboard shortcuts, so every entry point behaves the same.
 */
import {
  bodyToPlainText,
  editRefusal,
  messagePermissions,
  type Message,
  type MessagePermissions,
} from '@/core/domain';
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

/** Opens the forward dialog for this message (the dialog fetches its files and sends). */
export function forward(app: AppServices, m: Message): void {
  app.stores.ui.getState().openModal({
    type: 'forward',
    props: { conversationId: m.conversationId, messageIds: [m.id] },
  });
}

/**
 * Opens the editor, if the edit rules still allow it right now (a row on screen can outlive its
 * window): otherwise says why, rather than letting someone type text that can't be sent.
 */
export function startEdit(app: AppServices, m: Message): boolean {
  const reason = editRefusal(m, {
    selfId: app.stores.session.getState().self?.id ?? null,
    now: Date.now(),
  });
  if (reason !== undefined) {
    report(app, reason);
    return false;
  }
  app.stores.ui.getState().setEditing({ conversationId: m.conversationId, messageId: m.id });
  return true;
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

/** Sets our whole answer on a poll; a vote that couldn't go out is rolled back and says so. */
export async function votePoll(
  app: AppServices,
  m: Message,
  optionIndexes: readonly number[],
): Promise<void> {
  const result = await app.send.votePoll(m.conversationId, m, optionIndexes);
  if (result === 'failed') report(app, "Couldn't send your vote");
}

export async function endPoll(app: AppServices, m: Message): Promise<void> {
  const result = await app.send.endPoll(m.conversationId, m);
  if (result === 'failed') report(app, "Couldn't end the poll");
}

export function retry(app: AppServices, m: Message): void {
  if (m.nonce) void app.send.retry(m.conversationId, m.nonce);
}

export function discard(app: AppServices, m: Message): void {
  if (m.nonce) void app.send.discard(m.conversationId, m.nonce);
}

export type { MessagePermissions };

/** The shared rules (see `messagePermissions`) applied to the app's current state. */
export function permissionsFor(app: AppServices, m: Message): MessagePermissions {
  return messagePermissions(m, {
    selfId: app.stores.session.getState().self?.id ?? null,
    conversation: app.stores.conversations.getState().byId[m.conversationId],
    accepted: selectMessageRequestState(app.stores, m.conversationId) === 'accepted',
    capabilities: app.send.capabilities,
    now: Date.now(),
  });
}
