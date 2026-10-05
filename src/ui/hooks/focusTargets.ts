import type { ConversationId } from '@/core/domain';
import { describeFocus } from './textSurfaces';

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

/**
 * A plugin that wants every conversation-opening path to land focus
 * predictably — the composer reachable only through its own explicit keys,
 * never the "Focus the message box when opening a conversation" setting,
 * never wherever a click or a space switch happened to leave focus —
 * registers a policy here (Vim mode does, while its navigation keys are
 * on). While none is registered, every function below keeps today's
 * behaviour exactly.
 */
let focusPolicyActive: (() => boolean) | null = null;

/** Registers a conversation-focus policy. Returns an unregister function. */
export function setConversationFocusPolicy(isActive: () => boolean): () => void {
  focusPolicyActive = isActive;
  return () => {
    if (focusPolicyActive === isActive) focusPolicyActive = null;
  };
}

/** Whether a plugin's conversation-focus policy is currently active. */
export function conversationFocusPolicyActive(): boolean {
  return focusPolicyActive?.() ?? false;
}

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
  // A plugin's focus policy (Vim mode) always wins over "prefer the composer":
  // the setting that asks for it is ignored while that policy is active.
  const effective = preferComposer && !conversationFocusPolicyActive();
  const first = effective ? composerResolver?.(id) : listResolver?.(id);
  if (first) return first;
  const second = effective ? listResolver?.(id) : composerResolver?.(id);
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

/**
 * For a trigger that doesn't manage focus itself — a sidebar click, a space
 * switch — and only while a focus policy is active (see
 * `setConversationFocusPolicy`): lands on the new conversation's message
 * list, never the composer and never wherever the trigger left focus (the
 * row just clicked, the previous list), so keyboard navigation works right
 * away. A no-op when no policy is registered, so today's behaviour is
 * untouched outside it, and it never steals focus from another input, a
 * menu or a dialog.
 */
export function followConversationOpenFocus(id: ConversationId): void {
  if (!conversationFocusPolicyActive()) return;
  requestAnimationFrame(() => {
    const focus = describeFocus(document, false);
    if (focus.overlay || focus.target === 'input') return;
    conversationFocusTarget(id, false)?.focus();
  });
}
