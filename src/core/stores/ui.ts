/**
 * Ephemeral view state. Lives in a store (not component state) so commands,
 * keybinds and plugins can drive navigation without touching React.
 */
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ConversationId, Message, MessageId } from '@/core/domain';
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
  /**
   * The editor's text, kept here (not in the row) so it survives the row
   * being virtualised away and back. Undefined until the user types.
   */
  draft?: string;
  /**
   * Mentions picked while editing, kept beside the draft for the same reason.
   * Undefined until one is picked (the editor then starts from the message's own).
   */
  mentions?: readonly { id: string; label: string }[];
  /** The link whose preview card the user removed while editing (kept for the same reason). */
  dismissedPreview?: string;
  /** Unique per edit started (never reused, even after the edit closes), so the editor autofocuses once per edit, not on remount. */
  session?: number;
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

/** A jump to a message asked for from outside the chat column (global search). */
export interface RevealRequest {
  conversationId: ConversationId;
  messageId: MessageId;
}

export interface UiState {
  selectedSpace: SpaceSelection;
  /** Last opened conversation per space, so switching spaces feels like switching servers. */
  selectedConversationBySpace: Record<SpaceSelection, ConversationId>;
  memberListOpen: boolean;
  modal: ModalState | null;
  replyTo: Record<ConversationId, MessageId>;
  /**
   * The message each reply is to, as it was when last seen: the quote and the reply bar need it
   * after the message has left the loaded window (scrolled far away, or its window closed).
   */
  replySource: Record<ConversationId, Message>;
  editing: EditingTarget | null;
  scrollAnchors: Record<ConversationId, ScrollAnchor>;
  windowFocused: boolean;
  /** Consumed (and cleared) by the chat column, which owns the message list. */
  revealRequest: RevealRequest | null;
  toasts: Toast[];
  /**
   * Read-cursor snapshot taken when a conversation is opened. The "new
   * messages" divider uses this, so auto-marking read while the user looks at
   * the conversation doesn't make the divider jump or vanish.
   */
  unreadMarkers: Record<ConversationId, number>;
  /**
   * Conversations whose message list is scrolled away from the newest
   * message (or shows a detached window). Incoming messages there are not
   * "seen", so the sync engine doesn't auto-mark them read. Absent = the
   * bottom is visible.
   */
  scrolledUp: Record<ConversationId, true>;
  /**
   * A sign-out is under way. The flow clears the saved backend choice
   * early (it has to reach storage before the vault is removed), and the
   * app root would otherwise react by swapping to the Welcome screen and
   * unmounting the dialog that reports the flow's progress and errors. While
   * this is set the root keeps showing the running backend.
   */
  signingOut: boolean;

  selectSpace(space: SpaceSelection): void;
  selectConversation(conversationId: ConversationId, space?: SpaceSelection): void;
  toggleMemberList(open?: boolean): void;
  openModal(modal: ModalState): void;
  closeModal(): void;
  /** Opens the conversation (in `space`) and asks its list to scroll to the message. */
  requestReveal(request: RevealRequest, space?: SpaceSelection): void;
  clearRevealRequest(): void;
  setReplyTo(conversationId: ConversationId, messageId: MessageId | null, source?: Message): void;
  setEditing(target: EditingTarget | null): void;
  /** Updates the open editor's text (no-op when nothing is being edited). */
  setEditDraft(draft: string): void;
  /** Replaces the open editor's picked mentions (no-op when nothing is being edited). */
  setEditMentions(mentions: readonly { id: string; label: string }[]): void;
  /** Records that the open editor's preview card for `url` was removed (no-op when not editing). */
  dismissEditPreview(url: string): void;
  setScrollAnchor(conversationId: ConversationId, anchor: ScrollAnchor | null): void;
  setWindowFocused(focused: boolean): void;
  setUnreadMarker(conversationId: ConversationId, seq: number | null): void;
  setScrolledUp(conversationId: ConversationId, scrolledUp: boolean): void;
  setSigningOut(signingOut: boolean): void;
  pushToast(toast: Omit<Toast, 'id'>): string;
  dismissToast(id: string): void;
}

export type UiStore = StoreApi<UiState>;

export function createUiStore(newId: () => string = () => createNonce('toast')): UiStore {
  // Never reset: closing an edit must not make the next edit of the same message look like the
  // one before it (the editor autofocuses once per session).
  let editSessions = 0;
  return createStore<UiState>()((set, get) => ({
    selectedSpace: HOME,
    selectedConversationBySpace: {},
    memberListOpen: true,
    modal: null,
    revealRequest: null,
    replyTo: {},
    replySource: {},
    editing: null,
    scrollAnchors: {},
    windowFocused: true,
    toasts: [],
    unreadMarkers: {},
    scrolledUp: {},
    signingOut: false,

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
    requestReveal: (request, space) => {
      get().selectConversation(request.conversationId, space);
      set({ revealRequest: request });
    },
    clearRevealRequest: () => {
      set({ revealRequest: null });
    },
    setReplyTo: (conversationId, messageId, source) => {
      set((s) => {
        const { [conversationId]: _previous, ...rest } = s.replyTo;
        const { [conversationId]: _previousSource, ...restSource } = s.replySource;
        return {
          replyTo: messageId === null ? rest : { ...rest, [conversationId]: messageId },
          replySource:
            messageId !== null && source?.id === messageId
              ? { ...restSource, [conversationId]: source }
              : restSource,
        };
      });
    },
    setEditing: (editing) => {
      // Every edit started gets a session of its own, for the app's lifetime (autofocus once per
      // edit); a caller that passes `session` keeps its draft's session.
      set(
        editing === null
          ? { editing: null }
          : { editing: { ...editing, session: editing.session ?? ++editSessions } },
      );
    },
    setEditDraft: (draft) => {
      set((s) => (s.editing ? { editing: { ...s.editing, draft } } : s));
    },
    dismissEditPreview: (url) => {
      set((s) => (s.editing ? { editing: { ...s.editing, dismissedPreview: url } } : s));
    },
    setEditMentions: (mentions) => {
      set((s) => (s.editing ? { editing: { ...s.editing, mentions } } : s));
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
    setScrolledUp: (conversationId, scrolledUp) => {
      set((s) => {
        if ((s.scrolledUp[conversationId] === true) === scrolledUp) return s;
        const { [conversationId]: _previous, ...rest } = s.scrolledUp;
        return { scrolledUp: scrolledUp ? { ...rest, [conversationId]: true } : rest };
      });
    },
    setSigningOut: (signingOut) => {
      set({ signingOut });
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
  revealRequest: (s: UiState) => s.revealRequest,
  replyTo: (id: ConversationId) => (s: UiState) => s.replyTo[id] ?? null,
  editing: (s: UiState) => s.editing,
  toasts: (s: UiState) => s.toasts,
  unreadMarker: (id: ConversationId) => (s: UiState) => s.unreadMarkers[id],
  scrolledUp: (id: ConversationId) => (s: UiState) => s.scrolledUp[id] === true,
};
