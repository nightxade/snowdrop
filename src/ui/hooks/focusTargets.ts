import type { ConversationId } from '@/core/domain';

/**
 * Where keyboard focus should land after navigating to a conversation (quick
 * switcher, profile "Message", …). Two things register a preferred target:
 * the composer (explicit "type here" intent — a reply, or the "Focus the
 * message box" setting) and the message list (its roving tab stop, the
 * default landing spot everywhere else). Until either exists this is the
 * conversation's sidebar row.
 */
export type ConversationFocusResolver = (id: ConversationId) => HTMLElement | null | undefined;

let composerResolver: ConversationFocusResolver | null = null;
let listResolver: ConversationFocusResolver | null = null;

/** Registers the composer as a focus target. Returns an unregister function. */
export function setConversationFocusResolver(fn: ConversationFocusResolver): () => void {
  composerResolver = fn;
  return () => {
    if (composerResolver === fn) composerResolver = null;
  };
}

/** Registers the message list's roving tab stop as a focus target. Returns an unregister function. */
export function setConversationListFocusResolver(fn: ConversationFocusResolver): () => void {
  listResolver = fn;
  return () => {
    if (listResolver === fn) listResolver = null;
  };
}

const sidebarRow = (id: ConversationId): HTMLElement | null =>
  document.querySelector<HTMLElement>(
    `[data-snowdrop="sidebar"] [data-conversation-id="${CSS.escape(id)}"][data-roving-item]`,
  );

/**
 * The focus target for a conversation. By default this is the message list's
 * current row (the newest message); with `preferComposer` (the "Focus the
 * message box when opening a conversation" setting, or an explicit reply) it
 * is the composer instead. Either falls back to the other, then to the
 * conversation's sidebar row, so focus always lands somewhere real.
 */
export function conversationFocusTarget(
  id: ConversationId,
  preferComposer = false,
): HTMLElement | null {
  const first = preferComposer ? composerResolver?.(id) : listResolver?.(id);
  if (first) return first;
  const second = preferComposer ? listResolver?.(id) : composerResolver?.(id);
  if (second) return second;
  return sidebarRow(id);
}

/** Focuses the target once the navigation has rendered. */
export function focusConversation(id: ConversationId, preferComposer = false): void {
  requestAnimationFrame(() => {
    conversationFocusTarget(id, preferComposer)?.focus();
  });
}

/**
 * Call just before a command switches conversation (Alt+↑/↓, next unread,
 * Vim J/K/]u). Returns the function to call with the new conversation: it
 * moves focus deliberately instead of letting it fall to `<body>` when the
 * old view unmounts.
 *
 * From a sidebar row, focus follows to the new row (so you can keep
 * stepping). From anywhere else, it lands on `conversationFocusTarget` —
 * the message list's current row by default, or the composer when
 * `preferComposer` (the "Focus the message box when opening a conversation"
 * setting) is on.
 */
export function followConversationFocus(preferComposer = false): (id: ConversationId) => void {
  const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const fromRow =
    before?.matches('[data-roving-item][data-conversation-id]') === true &&
    before.closest('[data-snowdrop="sidebar"]') !== null;
  return (id) => {
    requestAnimationFrame(() => {
      if (fromRow) {
        const row = sidebarRow(id);
        if (row) {
          row.focus();
          return;
        }
      }
      conversationFocusTarget(id, preferComposer)?.focus();
    });
  };
}
