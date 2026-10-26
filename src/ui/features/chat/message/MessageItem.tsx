import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
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
  type ConversationId,
  type MessageId,
} from '@/core/domain';
import { messagesSelectors, sessionSelectors } from '@/core/stores';
import { BREAKPOINTS, overlayOwnsKeys, useMediaQuery, useSnowdrop } from '@/ui/hooks';
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
import { ConfirmDelete } from './ConfirmDelete';
import { ConfirmEndPoll } from './ConfirmEndPoll';
import { CustomEmojiDialog } from './CustomEmojiPopover';
import { HoverBar } from './HoverBar';
import { MessageActionSheet } from './MessageActionSheet';
import { MessageContent } from './MessageContent';
import { MessageDetails } from './MessageDetails';
import { PollVotesDialog } from './PollCard';
import { StickerPackDialog } from './StickerPackDialog';
import { buildMessageMenu, type DeleteKind } from './messageMenu';
import { QuoteHeader } from './QuoteHeader';
import { firstControl, useInertUntilEntered, useLongPress, useMessageNames } from './rowHooks';
import { isShiftHeld } from './useShiftHeld';
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
  const chat = useChatController();
  const m = useStore(stores.messages, messagesSelectors.message(conversationId, id));
  const nameFor = useMessageNames(m);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  // Re-renders the row when the conversation is accepted, so its actions (permissionsFor) unlock.
  useMessageRequestState(conversationId);
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
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirm, setConfirm] = useState<DeleteKind | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [votesOpen, setVotesOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const [emojiDialog, setEmojiDialog] = useState<string | null>(null);
  const longPress = useLongPress(() => {
    setSheetOpen(true);
  });

  useInertUntilEntered(row, entered);
  useRenderProbe(id);
  useLayoutEffect(() => rows.mount(id), [rows, id]);

  // Row actions for keyboard layers (Vim mode). Reads the message fresh, so
  // the registration itself stays stable across renders.
  const actions = useRef<RowActionHandler>(() => false);
  useEffect(() => {
    actions.current = (action) => {
      const msg = messagesSelectors.message(conversationId, id)(stores.messages.getState());
      if (!msg) return false;
      const p = act.permissionsFor(app, msg);
      const hasText = msg.kind === 'normal' && !msg.deleted;
      switch (action) {
        case 'reply':
          if (p.canReact) act.reply(app, chat, msg);
          return p.canReact;
        case 'edit':
          if (p.canEdit) act.startEdit(app, msg);
          return p.canEdit;
        case 'react':
          if (!p.canReact) return false;
          setFocused(true);
          setPickerOpen(true);
          return true;
        case 'copyText':
          if (hasText) act.copyMessageText(app, msg);
          return hasText;
        case 'copyMarkdown':
          if (hasText) act.copyMarkdown(app, msg);
          return hasText;
        case 'delete':
          // Always through the confirm dialog (like the Delete key without Shift).
          if (!p.failed) setConfirm(p.own && !msg.deleted ? 'everyone' : 'me');
          return !p.failed;
        case 'pin':
          if (p.canPin) act.setPinned(app, msg, !msg.pinned);
          return p.canPin;
        case 'open': {
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
        }
      }
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

  if (!m) return null;
  const perms = act.permissionsFor(app, m);
  const name = nameFor(m.authorId);
  const active = (hovered && !touch) || focused || menuOpen || contextOpen || pickerOpen;
  const mentionsMe = selfId !== null && m.authorId !== selfId && mentionsContact(m, selfId);
  const pending = isPendingMessageId(m.id) && m.status === 'pending';
  const labelId = `${domId}-label`;
  const bodyId = `${domId}-body`;

  /** After a delete, keep the keyboard somewhere sensible: the next message, else the composer. */
  const focusAfterDelete = () => {
    const all = [
      ...(row.current
        ?.closest('[data-snowdrop="message-log"]')
        ?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []),
    ];
    const next = all[all.indexOf(row.current as HTMLElement) + 1];
    // After the confirm dialog has closed and restored its own focus.
    setTimeout(() => {
      const nextId = next?.dataset.messageId as MessageId | undefined;
      if (next?.isConnected && nextId) {
        rows.setActive(nextId);
        next.focus();
      } else chat.focusComposer();
    }, 60);
  };
  const runDelete = (kind: DeleteKind) => {
    if (kind === 'everyone') act.deleteForEveryone(app, m);
    else if (kind === 'admin') act.adminDelete(app, m);
    else act.deleteForMe(app, m);
    focusAfterDelete();
  };
  const requestDelete = (kind: DeleteKind) => {
    if (isShiftHeld()) runDelete(kind);
    else setConfirm(kind);
  };
  const menu = () =>
    buildMessageMenu(app, chat, m, {
      openPicker: () => {
        setPickerOpen(true);
      },
      requestDelete,
      openDetails: () => {
        setDetailsOpen(true);
      },
      requestEndPoll: () => {
        setEndOpen(true);
      },
      openStickerPack: () => {
        setPackOpen(true);
      },
      openCustomEmoji: setEmojiDialog,
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
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'enter' && !editing) {
      rows.enter(id);
      setFocused(true);
    } else if (key === 'r' && perms.canReact) act.reply(app, chat, m);
    else if (key === 'e' && perms.canEdit) act.startEdit(app, m);
    else if ((key === '+' || key === '=') && perms.canReact) {
      setFocused(true);
      setPickerOpen(true);
    } else if ((key === 'delete' || key === 'backspace') && !perms.failed)
      requestDelete(perms.own && !m.deleted ? 'everyone' : 'me');
    else return;
    e.preventDefault();
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
      aria-keyshortcuts="Enter R E Plus Delete"
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
          permissions={perms}
          pickerOpen={pickerOpen}
          onPickerOpenChange={setPickerOpen}
          menuOpen={menuOpen}
          onMenuOpenChange={setMenuOpen}
          menu={menu}
          onReact={(emoji) => {
            act.react(app, m, emoji);
          }}
          onReply={() => {
            act.reply(app, chat, m);
          }}
          onEdit={() => {
            act.startEdit(app, m);
          }}
          onRetry={() => {
            act.retry(app, m);
          }}
          onQuickDelete={() => {
            runDelete(perms.own && !m.deleted ? 'everyone' : 'me');
          }}
        />
      )}
      {m.quote && !m.deleted && (
        <div className={styles.quote}>
          <QuoteHeader
            quote={m.quote}
            nameFor={nameFor}
            compact={compact}
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
        onViewPollVotes={() => {
          setVotesOpen(true);
        }}
        onOpenStickerPack={
          app.backend.getStickerPack
            ? () => {
                setPackOpen(true);
              }
            : undefined
        }
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
      {confirm && (
        <ConfirmDelete
          kind={confirm}
          message={m}
          onConfirm={() => {
            runDelete(confirm);
            setConfirm(null);
          }}
          onCancel={() => {
            setConfirm(null);
          }}
        />
      )}
      {detailsOpen && <MessageDetails message={m} onOpenChange={setDetailsOpen} />}
      {votesOpen && m.poll && (
        <PollVotesDialog
          poll={m.poll}
          onEnd={
            perms.canEndPoll
              ? () => {
                  setVotesOpen(false);
                  setEndOpen(true);
                }
              : undefined
          }
          onOpenChange={setVotesOpen}
        />
      )}
      {endOpen && m.poll && (
        <ConfirmEndPoll
          question={m.poll.question}
          onConfirm={() => {
            setEndOpen(false);
            void act.endPoll(app, m);
          }}
          onCancel={() => {
            setEndOpen(false);
          }}
        />
      )}
      {packOpen && m.sticker && (
        <StickerPackDialog
          conversationId={conversationId}
          sticker={m.sticker}
          onOpenChange={setPackOpen}
          // The sticker button isn't always focused after a click (WebKit), so name it.
          returnFocus={() =>
            row.current?.querySelector<HTMLElement>('[data-open-attachment]') ?? row.current
          }
        />
      )}
      {emojiDialog !== null &&
        (() => {
          const delivery = m.customEmoji?.find((d) => d.name === emojiDialog);
          return delivery ? (
            <CustomEmojiDialog
              conversationId={conversationId}
              delivery={delivery}
              onOpenChange={(open) => {
                if (!open) setEmojiDialog(null);
              }}
            />
          ) : null;
        })()}
    </>
  );
});
