/**
 * Imperative wiring between the chat column's parts: the header, commands
 * and composer ask the message list to scroll/reveal, and the drop overlay
 * hands files to the composer. Parts register handlers while mounted; calls
 * to an unmounted part are no-ops (or queued, for cross-conversation jumps).
 */
import { createContext, use, useSyncExternalStore } from 'react';
import type { ConversationId, MessageId } from '@/core/domain';
import type { MessageAction } from './list/rowState';

export interface RevealOptions {
  /** Highlight it briefly (default true). */
  flash?: boolean;
  /** Move keyboard focus to the row (quote jumps). */
  focus?: boolean;
}

/** Keyboard navigation of the message list (commands, Vim mode). */
export interface ListNavigation {
  /** Moves focus between messages; from outside the list the first press lands on its tab stop. */
  navigate(to: 'next' | 'prev' | 'first' | 'last', count: number): boolean;
  /** Scrolls by half a page or a line; focus follows like Vim's Ctrl+D / Ctrl+E. */
  scroll(by: 'halfPage' | 'line', direction: 1 | -1, count: number): void;
  /** Centres the focused message. */
  center(): void;
  /** Runs an action on the focused message (else the tab stop); false if it doesn't apply. */
  act(action: MessageAction): boolean;
  /** Focuses the list's tab stop. */
  focus(): void;
  /** Focuses the newest message and scrolls it into view (composer → messages). */
  focusLatest(): void;
}

export interface ListHandle extends ListNavigation {
  conversationId: ConversationId;
  /** Scrolls to the newest message, reloading the present first if detached. */
  jumpToPresent(): Promise<void>;
  /** Scrolls to (loading history around, if needed) and flashes a message. */
  reveal(messageId: MessageId, options?: RevealOptions): Promise<boolean>;
}

export interface ComposerHandle {
  conversationId: ConversationId;
  addFiles(files: readonly File[]): void;
  focus(): void;
}

export class ChatController {
  private list: ListHandle | null = null;
  private composer: ComposerHandle | null = null;
  /** A jump requested for a conversation whose list isn't mounted yet (mentions inbox). */
  private pending: {
    conversationId: ConversationId;
    messageId: MessageId;
    options?: RevealOptions;
  } | null = null;
  private searchOpen = false;
  private readonly listeners = new Set<() => void>();

  /** The in-conversation search panel (Ctrl+F), shared by the header button and the column. */
  isSearchOpen = (): boolean => this.searchOpen;

  setSearchOpen(open: boolean): void {
    if (this.searchOpen === open) return;
    this.searchOpen = open;
    for (const fn of this.listeners) fn();
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  registerList(handle: ListHandle): () => void {
    this.list = handle;
    const pending = this.pending;
    if (pending?.conversationId === handle.conversationId) {
      this.pending = null;
      void handle.reveal(pending.messageId, pending.options);
    }
    return () => {
      if (this.list === handle) this.list = null;
    };
  }

  registerComposer(handle: ComposerHandle): () => void {
    this.composer = handle;
    return () => {
      if (this.composer === handle) this.composer = null;
    };
  }

  jumpToPresent(): Promise<void> {
    return this.list?.jumpToPresent() ?? Promise.resolve();
  }

  /** Reveals a message; if its conversation's list isn't mounted, on mount. */
  reveal(
    conversationId: ConversationId,
    messageId: MessageId,
    options?: RevealOptions,
  ): Promise<boolean> {
    if (this.list?.conversationId === conversationId) return this.list.reveal(messageId, options);
    this.pending = { conversationId, messageId, ...(options ? { options } : {}) };
    return Promise.resolve(true);
  }

  addFiles(files: readonly File[]): void {
    this.composer?.addFiles(files);
  }

  focusComposer(): void {
    this.composer?.focus();
  }

  /** The open list's keyboard navigation, or null when no conversation is open. */
  get navigation(): ListNavigation | null {
    return this.list;
  }
}

const ChatControllerContext = createContext<ChatController | null>(null);

export const ChatControllerProvider = ChatControllerContext.Provider;

export function useChatController(): ChatController {
  const controller = use(ChatControllerContext);
  if (!controller) throw new Error('useChatController must be used inside <ChatColumn>');
  return controller;
}

export function useSearchOpen(): boolean {
  const controller = useChatController();
  return useSyncExternalStore(
    controller.subscribe,
    controller.isSearchOpen,
    controller.isSearchOpen,
  );
}
