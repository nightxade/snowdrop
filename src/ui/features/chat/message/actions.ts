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
import type { MessageAction } from '../list/rowState';

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
  const reason =
    editRefusal(m, {
      selfId: app.stores.session.getState().self?.id ?? null,
      now: Date.now(),
    }) ?? (permissionsFor(app, m).canEdit ? undefined : "You can't edit messages in this chat.");
  if (reason !== undefined) {
    report(app, reason);
    return false;
  }
  const ui = app.stores.ui.getState();
  const open = ui.editing;
  if (open?.conversationId === m.conversationId && open.messageId === m.id) {
    // Already being edited: keep what was typed (a new session only brings the editor focus).
    const { session: _spent, ...same } = open;
    ui.setEditing(same);
  } else ui.setEditing({ conversationId: m.conversationId, messageId: m.id });
  return true;
}

/** Picking an emoji you already reacted with removes it (Signal Desktop, Discord); another one switches to it. */
export function react(app: AppServices, m: Message, emoji: string): void {
  toggleReaction(app, m, emoji);
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

export type DeleteKind = 'everyone' | 'me' | 'admin';

/** What a plain Delete does: for everyone on our own message, otherwise for ourselves. */
export function deleteKindOf(p: MessagePermissions): DeleteKind {
  return p.canDeleteForEveryone ? 'everyone' : 'me';
}

/** Every operation a message offers, whichever surface (key, command, menu, hover bar) reaches it. */
export type MessageActionId =
  | MessageAction
  | 'retry'
  | 'discard'
  | 'details'
  | 'endPoll'
  | 'deleteEveryone'
  | 'deleteAdmin'
  | 'deleteMe';

/** What an action needs to run: the message, its permissions, and the row's own UI hooks. */
export interface ActionContext {
  app: AppServices;
  chat: ChatController;
  m: Message;
  p: MessagePermissions;
  openPicker: () => void;
  /** Asks before deleting, or deletes at once on the surfaces where Shift skips the question. */
  requestDelete: (kind: DeleteKind) => void;
  openDetails: () => void;
  requestEndPoll: () => void;
  /** Opens the row's attachment or jumps to its quote; false when it has neither. */
  open: () => boolean;
}

interface ActionDef {
  enabled: (p: MessagePermissions, m: Message) => boolean;
  /**
   * The command layer's gate, where it is looser than `enabled`: it hands the call to `run`, which
   * checks again and says why not.
   */
  commandEnabled?: (p: MessagePermissions, m: Message) => boolean;
  /** Does it; false when it did not apply. */
  run: (ctx: ActionContext) => boolean;
}

const done = (fn: () => void): boolean => {
  fn();
  return true;
};

export const MESSAGE_ACTIONS: Record<MessageActionId, ActionDef> = {
  retry: {
    enabled: (p) => p.failed,
    run: ({ app, m }) =>
      done(() => {
        retry(app, m);
      }),
  },
  discard: {
    enabled: (p) => p.failed,
    run: ({ app, m }) =>
      done(() => {
        discard(app, m);
      }),
  },
  react: { enabled: (p) => p.canReact, run: ({ openPicker }) => done(openPicker) },
  reply: {
    enabled: (p) => p.canReply,
    run: ({ app, chat, m }) =>
      done(() => {
        reply(app, chat, m);
      }),
  },
  forward: {
    enabled: (p) => p.canForward,
    run: ({ app, m }) =>
      done(() => {
        forward(app, m);
      }),
  },
  edit: {
    enabled: (p) => p.canEdit,
    // Asks again (and says why not) in case the window closed since the permissions were read.
    commandEnabled: (p) => p.own,
    run: ({ app, m }) => startEdit(app, m),
  },
  pin: {
    enabled: (p) => p.canPin,
    run: ({ app, m }) =>
      done(() => {
        setPinned(app, m, !m.pinned);
      }),
  },
  endPoll: { enabled: (p) => p.canEndPoll, run: ({ requestEndPoll }) => done(requestEndPoll) },
  details: { enabled: (p) => p.canShowDetails, run: ({ openDetails }) => done(openDetails) },
  copyText: {
    enabled: (p) => p.canCopy,
    run: ({ app, m }) =>
      done(() => {
        copyMessageText(app, m);
      }),
  },
  copyMarkdown: {
    enabled: (p) => p.canCopy,
    run: ({ app, m }) =>
      done(() => {
        copyMarkdown(app, m);
      }),
  },
  delete: {
    enabled: (p) => p.canDelete,
    run: ({ p, requestDelete }) =>
      done(() => {
        requestDelete(deleteKindOf(p));
      }),
  },
  deleteEveryone: {
    enabled: (p) => p.canDelete && p.canDeleteForEveryone,
    run: ({ requestDelete }) =>
      done(() => {
        requestDelete('everyone');
      }),
  },
  deleteAdmin: {
    enabled: (p) => p.canDelete && p.canAdminDelete,
    run: ({ requestDelete }) =>
      done(() => {
        requestDelete('admin');
      }),
  },
  // Same gate as `delete`; named apart so the menu can list "Delete for me" explicitly.
  deleteMe: {
    enabled: (p) => p.canDelete,
    run: ({ requestDelete }) =>
      done(() => {
        requestDelete('me');
      }),
  },
  open: { enabled: () => true, run: ({ open }) => open() },
};

export function messageActionEnabled(
  id: MessageActionId,
  p: MessagePermissions,
  m: Message,
): boolean {
  return MESSAGE_ACTIONS[id].enabled(p, m);
}

/** Runs the action if it is enabled (the command layer's looser gate when `command`). */
export function runMessageAction(
  id: MessageActionId,
  ctx: ActionContext,
  gate: 'surface' | 'command' = 'surface',
): boolean {
  const def = MESSAGE_ACTIONS[id];
  const ok = gate === 'command' && def.commandEnabled ? def.commandEnabled : def.enabled;
  return ok(ctx.p, ctx.m) && def.run(ctx);
}
