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
