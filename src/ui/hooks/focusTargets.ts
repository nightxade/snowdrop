import type { ConversationId } from '@/core/domain';

/**
 * Where keyboard focus should land after navigating to a conversation (quick
 * switcher, profile "Message", …). Until the composer exists this is the
 * conversation's sidebar row; the composer registers a resolver so that
 * "go to conversation" puts the caret where you'll type.
 */
export type ConversationFocusResolver = (id: ConversationId) => HTMLElement | null | undefined;

let resolver: ConversationFocusResolver | null = null;

/** Registers the preferred focus target (e.g. the composer). Returns an unregister function. */
export function setConversationFocusResolver(fn: ConversationFocusResolver): () => void {
  resolver = fn;
  return () => {
    if (resolver === fn) resolver = null;
  };
}

export function conversationFocusTarget(id: ConversationId): HTMLElement | null {
  const preferred = resolver?.(id);
  if (preferred) return preferred;
  return document.querySelector<HTMLElement>(
    `[data-conversation-id="${CSS.escape(id)}"][data-roving-item]`,
  );
}

/** Focuses the target once the navigation has rendered. */
export function focusConversation(id: ConversationId): void {
  requestAnimationFrame(() => {
    conversationFocusTarget(id)?.focus();
  });
}

const sidebarRow = (id: ConversationId): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[data-snowdrop="sidebar"] [data-conversation-id="${CSS.escape(id)}"][data-roving-item]`,
  );

/**
 * Call just before a command switches conversation (Alt+↑/↓, next unread,
 * Vim J/K/]u). Returns the function to call with the new conversation: it
 * moves focus deliberately instead of letting it fall to `<body>` when the
 * old view unmounts. From a sidebar row, focus follows to the new row (so
 * you can keep stepping); from the chat column, or from anywhere the switch
 * removed, it lands in the new conversation's composer.
 */
export function followConversationFocus(): (id: ConversationId) => void {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fromRow =
    before?.matches('[data-roving-item][data-conversation-id]') === true &&
    before.closest('[data-snowdrop="sidebar"]') !== null;
  const fromChat = !before || before === document.body || before.closest('[data-snowdrop="chat"]');
  return (id) => {
    requestAnimationFrame(() => {
      if (fromRow) {
        const row = sidebarRow(id);
        if (row) {
          row.focus();
          return;
        }
      }
      if (fromRow || fromChat || !before.isConnected) conversationFocusTarget(id)?.focus();
    });
  };
}
