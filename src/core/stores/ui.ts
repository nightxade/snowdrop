/**
 * Ephemeral view state. Lives in a store (not component state) so commands,
 * keybinds and plugins can drive navigation without touching React.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationId, MessageId } from '@/core/domain';
import { createNonce } from '@/core/lib';
import type { SpaceId } from './spaces';

/** Pseudo space id for Home (all DMs + unassigned groups). */
export const HOME = 'home';
/** `HOME` or a SpaceId. */
export type SpaceSelection = SpaceId;

export interface ModalState {
  type: string;
  props?: Record<string, unknown>;
}

export interface EditingTarget {
  conversationId: ConversationId;
  messageId: MessageId;
}

/** Where the list was scrolled, so switching back restores the position. */
export interface ScrollAnchor {
  messageId: MessageId;
  offset: number;
  atBottom: boolean;
}

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  id: string;
  message: string;
  kind: ToastKind;
  /** Plugin id or "core", shown for attribution. */
  source: string;
}

/** Oldest toasts are dropped beyond this, so a chatty plugin can't flood the screen. */
export const MAX_TOASTS = 4;

export interface UiState {
  selectedSpace: SpaceSelection;
  /** Last opened conversation per space, so switching spaces feels like switching servers. */
  selectedConversationBySpace: Record<SpaceSelection, ConversationId>;
  memberListOpen: boolean;
  modal: ModalState | null;
  replyTo: Record<ConversationId, MessageId>;
  editing: EditingTarget | null;
  scrollAnchors: Record<ConversationId, ScrollAnchor>;
  windowFocused: boolean;
  toasts: Toast[];
  /**
   * Read-cursor snapshot taken when a conversation is opened. The "new
   * messages" divider uses this, so auto-marking read while the user looks at
   * the conversation doesn't make the divider jump or vanish.
   */
  unreadMarkers: Record<ConversationId, number>;

  selectSpace(space: SpaceSelection): void;
  selectConversation(conversationId: ConversationId, space?: SpaceSelection): void;
  toggleMemberList(open?: boolean): void;
  openModal(modal: ModalState): void;
  closeModal(): void;
  setReplyTo(conversationId: ConversationId, messageId: MessageId | null): void;
  setEditing(target: EditingTarget | null): void;
  setScrollAnchor(conversationId: ConversationId, anchor: ScrollAnchor | null): void;
  setWindowFocused(focused: boolean): void;
  setUnreadMarker(conversationId: ConversationId, seq: number | null): void;
  pushToast(toast: Omit<Toast, 'id'>): string;
  dismissToast(id: string): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(newId: () => string = () => createNonce('toast')): UiStore {
  return createStore<UiState>()((set) => ({
    selectedSpace: HOME,
    selectedConversationBySpace: {},
    memberListOpen: true,
    modal: null,
    replyTo: {},
    editing: null,
    scrollAnchors: {},
    windowFocused: true,
    toasts: [],
    unreadMarkers: {},

    selectSpace: (selectedSpace) => {
      set({ selectedSpace });
    },
    selectConversation: (conversationId, space) => {
      set((s) => {
        const target = space ?? s.selectedSpace;
        return {
          selectedSpace: target,
          selectedConversationBySpace: {
            ...s.selectedConversationBySpace,
            [target]: conversationId,
          },
          editing: null,
        };
      });
    },
    toggleMemberList: (open) => {
      set((s) => ({ memberListOpen: open ?? !s.memberListOpen }));
    },
    openModal: (modal) => {
      set({ modal });
    },
    closeModal: () => {
      set({ modal: null });
    },
    setReplyTo: (conversationId, messageId) => {
      set((s) => {
        const { [conversationId]: _previous, ...rest } = s.replyTo;
        return { replyTo: messageId === null ? rest : { ...rest, [conversationId]: messageId } };
      });
    },
    setEditing: (editing) => {
      set({ editing });
    },
    setScrollAnchor: (conversationId, anchor) => {
      set((s) => {
        const { [conversationId]: _previous, ...rest } = s.scrollAnchors;
        return { scrollAnchors: anchor === null ? rest : { ...rest, [conversationId]: anchor } };
      });
    },
    setWindowFocused: (windowFocused) => {
      set({ windowFocused });
    },
    setUnreadMarker: (conversationId, seq) => {
      set((s) => {
        const { [conversationId]: _previous, ...rest } = s.unreadMarkers;
        return { unreadMarkers: seq === null ? rest : { ...rest, [conversationId]: seq } };
      });
    },
    pushToast: (toast) => {
      const id = newId();
      set((s) => ({ toasts: [...s.toasts, { ...toast, id }].slice(-MAX_TOASTS) }));
      return id;
    },
    dismissToast: (id) => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  }));
}

export const uiSelectors = {
  selectedSpace: (s: UiState) => s.selectedSpace,
  selectedConversation: (s: UiState): ConversationId | null =>
    s.selectedConversationBySpace[s.selectedSpace] ?? null,
  memberListOpen: (s: UiState) => s.memberListOpen,
  modal: (s: UiState) => s.modal,
  replyTo: (id: ConversationId) => (s: UiState) => s.replyTo[id] ?? null,
  editing: (s: UiState) => s.editing,
  toasts: (s: UiState) => s.toasts,
  unreadMarker: (id: ConversationId) => (s: UiState) => s.unreadMarkers[id],
};
