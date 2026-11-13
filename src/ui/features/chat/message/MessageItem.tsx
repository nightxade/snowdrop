import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { useStore } from 'zustand';
import {
  formatClock,
  isPendingMessageId,
  mentionsContact,
  messageId,
  canSendToGroup,
  EDIT_WINDOW_MS,
  isNoteToSelf,
  type ConversationId,
  type Message,
  type MessageId,
} from '@/core/domain';
import { messagesSelectors, sessionSelectors } from '@/core/stores';
import {
  BREAKPOINTS,
  overlayOwnsKeys,
  useBackendFeature,
  useMediaQuery,
  useSnowdrop,
} from '@/ui/hooks';
import { ContextMenu, Drawer, EmojiPicker, VisuallyHidden } from '@/ui/primitives';
import { useMessageRequestState } from '@/ui/features/conversation';
import { useChatController } from '../ChatController';
import { useHistoryRead } from './useHistoryRead';
import {
  useRowActive,
  useRowEntered,
  useRowFlashing,
  useRowHovered,
  useRowState,
  type RowActionHandler,
} from '../list/rowState';
import * as act from './actions';
import { HoverBar } from './HoverBar';
import { MessageActionSheet } from './MessageActionSheet';
import { MessageContent } from './MessageContent';
import { buildMessageMenu } from './messageMenu';
import { useMessageDialogs } from './useMessageDialogs';
import { QuoteHeader } from './QuoteHeader';
import { firstControl, useInertUntilEntered, useLongPress, useMessageNames } from './rowHooks';
import { useRenderProbe } from '../lib/useRenderProbe';
import styles from './MessageItem.module.css';

export interface MessageItemProps {
  conversationId: ConversationId;
  id: MessageId;
  /** Continues the previous author's group: no avatar/header (comfortable). */
  continuation: boolean;
  compact: boolean;
  /** Show 16px avatars in compact mode. */
  compactAvatars: boolean;
}

/** Row key bindings (Enter and Control+Shift+S are handled apart). */
const KEY_ACTIONS: Partial<Record<string, act.MessageActionId>> = {
  r: 'reply',
  e: 'edit',
  '+': 'react',
  '=': 'react',
  delete: 'delete',
  backspace: 'delete',
};

const MAX_TIMER_MS = 2 ** 31 - 1;

/** Touch-first layouts: no hover bar on tap; long-press opens an action sheet instead. */
const TOUCH_QUERY = `(pointer: coarse), ${BREAKPOINTS.drawer}`;

/**
 * One message row (role=article). Subscribes to its own message by id, so
 * an edit, reaction or receipt re-renders only this row. Keyboard: the list
 * is one roving tab stop; Enter steps into the row's controls (hover bar
 * first), Escape steps back out; R/E/+/Delete act on the row.
 */
export const MessageItem = memo(function MessageItem({
  conversationId,
  id,
  continuation,
  compact,
  compactAvatars,
}: MessageItemProps) {
  const app = useSnowdrop();
  const { stores } = app;
  const hasStickers = useBackendFeature('stickers');
  const chat = useChatController();
  const m = useStore(stores.messages, messagesSelectors.message(conversationId, id));
  const nameFor = useMessageNames(m);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  // Re-render the row when the conversation is accepted or the user may (no longer) write in it,
  // so its actions (permissionsFor) unlock and lock.
  useMessageRequestState(conversationId);
  useStore(stores.conversations, (s) => canSendToGroup(s.byId[conversationId], selfId));
  const clock24h = useStore(stores.settings, (s) => s.appearance.clock24h);
  const editing = useStore(stores.ui, (s) => s.editing?.messageId === id);
  const replyTarget = useStore(stores.ui, (s) => s.replyTo[conversationId] === id);
  const touch = useMediaQuery(TOUCH_QUERY);
  const rows = useRowState();
  const hovered = useRowHovered(id);
  const flash = useRowFlashing(id);
  const tabStop = useRowActive(id);
  const entered = useRowEntered(id);
  const row = useRef<HTMLDivElement>(null);
  useHistoryRead(row, m);
  const domId = useId();
  const [focused, setFocused] = useState(false);
  const [, closeWindows] = useReducer((n: number) => n + 1, 0);
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const perms = m ? act.permissionsFor(app, m) : undefined;
  const { callbacks: dialog, dialogs } = useMessageDialogs(m, row, perms);
  /** What the table's actions run with; each surface overrides what it does differently. */
  const actionContext = (
    msg: Message,
    p: act.MessagePermissions,
    over: Partial<act.ActionContext> = {},
  ): act.ActionContext => ({
    app,
    chat,
    m: msg,
    p,
    openPicker: () => {
      setFocused(true);
      setPickerOpen(true);
    },
    requestDelete: dialog.requestDelete,
    openDetails: dialog.openDetails,
    requestEndPoll: dialog.requestEndPoll,
    open: () => false,
    ...over,
  });
  const longPress = useLongPress(() => {
    setSheetOpen(true);
  });

  useInertUntilEntered(row, entered);
  useRenderProbe(id);
  // Edit and delete-for-everyone close 24 hours after sending: re-render the row then, so its
  // bar and menu stop offering them without waiting for something else to touch it.
  const windowCloses =
    m && m.authorId === selfId && !isNoteToSelf(conversationId, selfId)
      ? m.sentAt + EDIT_WINDOW_MS
      : undefined;
  useEffect(() => {
    if (windowCloses === undefined) return;
    const wait = windowCloses - Date.now();
    // Not for a message long past it, nor beyond what a timer can hold.
    if (wait <= 0 || wait > MAX_TIMER_MS) return;
    const timer = setTimeout(closeWindows, wait + 50);
    return () => {
      clearTimeout(timer);
    };
  }, [windowCloses]);
  useLayoutEffect(() => rows.mount(id), [rows, id]);

  // Row actions for keyboard layers (Vim mode). Reads the message fresh, so
  // the registration itself stays stable across renders.
  const actions = useRef<RowActionHandler>(() => false);
  useEffect(() => {
    actions.current = (action) => {
      const msg = messagesSelectors.message(conversationId, id)(stores.messages.getState());
      if (!msg) return false;
      const p = act.permissionsFor(app, msg);
      const ctx = actionContext(msg, p, {
        // Always through the confirm dialog (like the Delete key without Shift).
        requestDelete: dialog.confirmDelete,
        open: () => {
          const media = row.current?.querySelector<HTMLElement>('[data-open-attachment]');
          if (media) {
            media.click();
            return true;
          }
          const quoted = msg.quote;
          if (!quoted || msg.deleted) return false;
          void chat.reveal(conversationId, messageId(quoted.authorId, quoted.sentAt), {
            focus: true,
          });
          return true;
        },
      });
      return act.runMessageAction(action, ctx, 'command');
    };
  });
  useLayoutEffect(() => rows.registerActions(id, (action) => actions.current(action)), [rows, id]);
  // Entering moves focus to the first control (the hover bar once it has mounted).
  useEffect(() => {
    if (!entered || !row.current) return;
    const frame = requestAnimationFrame(() => {
      if (row.current?.contains(document.activeElement) && document.activeElement !== row.current)
        return;
      const target = row.current ? firstControl(row.current) : null;
      target?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [entered]);

  if (!m || !perms) return null;
  const name = nameFor(m.authorId);
  const active = (hovered && !touch) || focused || menuOpen || contextOpen || pickerOpen;
  const mentionsMe = selfId !== null && m.authorId !== selfId && mentionsContact(m, selfId);
  const pending = isPendingMessageId(m.id) && m.status === 'pending';
  const labelId = `${domId}-label`;
  const bodyId = `${domId}-body`;

  const menu = () =>
    buildMessageMenu(app, chat, m, {
      openPicker: () => {
        setPickerOpen(true);
      },
      requestDelete: dialog.requestDelete,
      openDetails: dialog.openDetails,
      requestEndPoll: dialog.requestEndPoll,
      openStickerPack: dialog.openStickerPack,
      openCustomEmoji: dialog.openCustomEmoji,
    });
  const leaveRow = () => {
    rows.enter(null);
    row.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.target !== e.currentTarget) {
      // Escape steps out of an entered row — unless it just closed a menu or
      // popover. (A tooltip also "handles" Escape, but shouldn't cost a press.)
      if (e.key === 'Escape' && entered && !overlayOwnsKeys(document)) {
        e.preventDefault();
        leaveRow();
      }
      return;
    }
    if (e.defaultPrevented) return;
    // Decided now, not when the row last rendered: an edit window may have closed since.
    const live = act.permissionsFor(app, m);
    const ctx = actionContext(m, live);
    // Enabled means handled, even if the action then declines (an edit says why not).
    const run = (action: act.MessageActionId) => {
      if (!act.messageActionEnabled(action, live, m)) return false;
      act.runMessageAction(action, ctx);
      return true;
    };
    // Signal Desktop's shortcut for forwarding the focused message.
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
      if (!run('forward')) return;
      e.preventDefault();
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'enter' && !editing) {
      rows.enter(id);
      setFocused(true);
      e.preventDefault();
      return;
    }
    const action = Object.hasOwn(KEY_ACTIONS, key) ? KEY_ACTIONS[key] : undefined;
    if (action && run(action)) e.preventDefault();
  };

  // The row's own context menu replaces the bar (and the time tooltip) while it's open.
  const showBar = active && !editing && m.kind === 'normal' && !touch && !contextOpen;
  const article = (
    <div
      ref={row}
      className={styles.row}
      role="article"
      aria-labelledby={labelId}
      aria-describedby={bodyId}
      aria-keyshortcuts="Enter R E Plus Delete Control+Shift+S"
      data-snowdrop="message"
      data-compact={compact ? '' : undefined}
      data-continuation={continuation && !compact ? '' : undefined}
      data-mention={mentionsMe ? '' : undefined}
      data-reply-target={replyTarget ? '' : undefined}
      data-pending={pending ? '' : undefined}
      data-failed={perms.failed ? '' : undefined}
      data-flash={flash ? '' : undefined}
      data-message-active={active ? '' : undefined}
      // The roving tab stop (j/k, gg/G land here): a stable marker that
      // doesn't depend on `:focus-visible` (see MessageItem.module.css).
      data-current={tabStop ? '' : undefined}
      data-roving-item
      data-message-id={m.id}
      tabIndex={tabStop ? 0 : -1}
      onPointerEnter={(e) => {
        if (e.pointerType === 'mouse') rows.setHovered(id);
      }}
      onPointerMove={(e) => {
        // Re-claims hover after a scroll moved another row under the pointer.
        if (e.pointerType === 'mouse' && !hovered) rows.setHovered(id);
        longPress.onPointerMove(e);
      }}
      onPointerLeave={() => {
        rows.leave(id);
      }}
      onPointerDown={longPress.onPointerDown}
      onPointerUp={longPress.onPointerUp}
      onPointerCancel={longPress.onPointerCancel}
      onContextMenu={(e) => {
        // On touch the long-press sheet replaces the browser's own menu.
        if (touch) e.preventDefault();
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) rows.setActive(id);
        // Keyboard focus shows the hover bar; a mouse click inside the row doesn't pin it.
        setFocused(e.target.matches(':focus-visible'));
      }}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        setFocused(false);
        if (entered) rows.enter(null);
      }}
      onKeyDown={onKeyDown}
    >
      <VisuallyHidden id={labelId}>
        {`${name}, ${formatClock(m.sentAt, { clock24h })}${m.editedAt !== undefined ? ', edited' : ''}`}
      </VisuallyHidden>
      {/* First in DOM order so Enter → Tab reaches it before the content. */}
      {showBar && (
        <HoverBar
          message={m}
          actions={actionContext(m, perms, { requestDelete: dialog.runDelete })}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          menu={menu}
          onReact={(emoji) => {
            act.react(app, m, emoji);
          }}
        />
      )}
      {m.quote && !m.deleted && (
        <div className={styles.quote}>
          <QuoteHeader
            quote={m.quote}
            nameFor={nameFor}
            compact={compact}
            conversationId={conversationId}
            onJump={() => {
              const quoted = m.quote;
              if (quoted)
                void chat.reveal(conversationId, messageId(quoted.authorId, quoted.sentAt), {
                  focus: true,
                });
            }}
          />
        </div>
      )}
      <MessageContent
        message={m}
        conversationId={conversationId}
        nameFor={nameFor}
        selfId={selfId}
        compact={compact}
        compactAvatars={compactAvatars}
        continuation={continuation}
        editing={editing}
        pending={pending}
        menuOpen={contextOpen}
        bodyId={bodyId}
        onEditDone={leaveRow}
        onViewPollVotes={dialog.openPollVotes}
        onOpenStickerPack={hasStickers ? dialog.openStickerPack : undefined}
      />
    </div>
  );

  let wrapped: ReactElement = article;
  if (!touch)
    wrapped = (
      <ContextMenu entries={menu} onOpenChange={setContextOpen} label="Message actions">
        {article}
      </ContextMenu>
    );

  return (
    <>
      {wrapped}
      {touch && <MessageActionSheet open={sheetOpen} onOpenChange={setSheetOpen} entries={menu} />}
      {touch && pickerOpen && (
        // No hover bar to anchor to on touch: the full picker comes up as a sheet.
        <Drawer side="bottom" open onOpenChange={setPickerOpen} label="Add reaction">
          <EmojiPicker
            autoFocus={false}
            onSelect={(emoji) => {
              setPickerOpen(false);
              act.react(app, m, emoji);
            }}
          />
        </Drawer>
      )}
      {dialogs}
    </>
  );
});
