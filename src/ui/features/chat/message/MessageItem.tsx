import { memo, useCallback, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import {
  formatClock,
  initialsFor,
  isPendingMessageId,
  mentionsContact,
  messageId,
  type ConversationId,
  type MessageId,
} from '@/core/domain';
import {
  contactsSelectors,
  messagesSelectors,
  sessionSelectors,
  UNKNOWN_CONTACT_NAME,
} from '@/core/stores';
import { useHearth, useObservableList } from '@/ui/hooks';
import { Avatar, ContextMenu, Slot } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import * as act from './actions';
import { Attachments } from './Attachments';
import { AuthorPopover } from './AuthorPopover';
import { ConfirmDelete } from './ConfirmDelete';
import { HoverBar } from './HoverBar';
import { MessageBody } from './MessageBody';
import { MessageEditor } from './MessageEditor';
import { EditedTag } from './EditedTag';
import { MessageMeta } from './MessageMeta';
import { MessageNotes } from './MessageNotes';
import { buildMessageMenu, type DeleteKind } from './messageMenu';
import { QuoteHeader } from './QuoteHeader';
import { Reactions } from './Reactions';
import { useRowFlashing, useRowHovered, useRowState } from '../list/rowState';
import { isShiftHeld } from './useShiftHeld';
import styles from './MessageItem.module.css';

export interface MessageItemProps {
  conversationId: ConversationId;
  id: MessageId;
  /** Continues the previous author's group: no avatar/header (cozy). */
  continuation: boolean;
  compact: boolean;
  /** Show 16px avatars in compact mode. */
  compactAvatars: boolean;
}

/**
 * One message row. Subscribes to its own message by id, so an edit,
 * reaction or receipt re-renders only this row. The hover bar and pickers
 * mount only while the row is hovered/focused.
 */
export const MessageItem = memo(function MessageItem({
  conversationId,
  id,
  continuation,
  compact,
  compactAvatars,
}: MessageItemProps) {
  const app = useHearth();
  const { stores } = app;
  const chat = useChatController();
  const m = useStore(stores.messages, messagesSelectors.message(conversationId, id));
  const author = useStore(stores.contacts, contactsSelectors.contact(m?.authorId ?? ''));
  const contacts = useStore(stores.contacts, contactsSelectors.byId);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const editing = useStore(stores.ui, (s) => s.editing?.messageId === id);
  const accessories = useObservableList(app.registries.messageAccessories);
  const decorations = useObservableList(app.registries.messageDecorations);
  const rows = useRowState();
  const hovered = useRowHovered(id);
  const flash = useRowFlashing(id);
  const [focused, setFocused] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirm, setConfirm] = useState<DeleteKind | null>(null);

  const nameFor = useCallback(
    (contactId: string) => contacts[contactId]?.name ?? UNKNOWN_CONTACT_NAME,
    [contacts],
  );

  if (!m) return null;
  const perms = act.permissionsFor(app, m);
  const name = author?.name ?? UNKNOWN_CONTACT_NAME;
  const color = author?.color ?? 'var(--hearth-avatar-1)';
  const active = hovered || focused || menuOpen || contextOpen || pickerOpen;
  const mentionsMe = selfId !== null && m.authorId !== selfId && mentionsContact(m, selfId);
  const showHeader = compact || !continuation;
  const pending = isPendingMessageId(m.id) && m.status === 'pending';

  const runDelete = (kind: DeleteKind) => {
    if (kind === 'everyone') act.deleteForEveryone(app, m);
    else if (kind === 'admin') act.adminDelete(app, m);
    else act.deleteForMe(app, m);
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
    });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    if (key === 'r' && perms.canReact) act.reply(app, chat, m);
    else if (key === 'e' && perms.canEdit) act.startEdit(app, m);
    else if ((key === '+' || key === '=') && perms.canReact) setPickerOpen(true);
    else if ((key === 'delete' || key === 'backspace') && !perms.failed)
      requestDelete(perms.own && !m.deleted ? 'everyone' : 'me');
    else return;
    e.preventDefault();
  };

  const avatar = (
    <Avatar
      size={compact ? 16 : 40}
      {...(author?.avatarUrl ? { src: author.avatarUrl } : {})}
      fallback={compact ? '' : initialsFor(name)}
      color={color}
    />
  );
  const nameButton = (
    <button
      type="button"
      className={styles.name}
      style={{ '--name-color': color } as CSSProperties}
    >
      {name}
    </button>
  );

  return (
    <>
      <ContextMenu entries={menu} onOpenChange={setContextOpen} label="Message actions">
        <div
          className={styles.row}
          data-hearth="message"
          data-compact={compact ? '' : undefined}
          data-continuation={continuation && !compact ? '' : undefined}
          data-mention={mentionsMe ? '' : undefined}
          data-pending={pending ? '' : undefined}
          data-failed={perms.failed ? '' : undefined}
          data-flash={flash ? '' : undefined}
          data-message-active={active ? '' : undefined}
          data-roving-item
          data-message-id={m.id}
          tabIndex={-1}
          aria-label={`${name}, ${formatClock(m.sentAt, { clock24h: true })}`}
          onPointerEnter={() => {
            rows.setHovered(id);
          }}
          onPointerMove={() => {
            // Re-claims hover after a scroll moved another row under the pointer.
            if (!hovered) rows.setHovered(id);
          }}
          onPointerLeave={() => {
            rows.leave(id);
          }}
          onFocus={(e) => {
            // Keyboard focus shows the hover bar; a mouse click inside the row doesn't pin it.
            setFocused(e.target.matches(':focus-visible'));
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
          }}
          onKeyDown={onKeyDown}
        >
          {m.quote && !m.deleted && (
            <div className={styles.quote}>
              <QuoteHeader
                quote={m.quote}
                nameFor={nameFor}
                compact={compact}
                onJump={() => {
                  const quoted = m.quote;
                  if (quoted)
                    void chat.reveal(conversationId, messageId(quoted.authorId, quoted.sentAt));
                }}
              />
            </div>
          )}
          <div className={styles.gutter}>
            {!compact && showHeader && (
              <AuthorPopover contactId={m.authorId} conversationId={conversationId}>
                <button
                  type="button"
                  className={styles.avatarButton}
                  aria-label={`${name}'s profile`}
                >
                  {avatar}
                </button>
              </AuthorPopover>
            )}
            {!compact && !showHeader && <MessageMeta message={m} variant="gutter" />}
            {compact && <MessageMeta message={m} variant="compact" />}
          </div>
          <div className={styles.content}>
            {showHeader && (
              <span className={styles.header}>
                {compact && compactAvatars && (
                  <span className={styles.compactAvatar}>{avatar}</span>
                )}
                <AuthorPopover contactId={m.authorId} conversationId={conversationId}>
                  {nameButton}
                </AuthorPopover>
                {decorations.length > 0 && (
                  <Slot
                    name="message.decorations"
                    className={styles.decorations}
                    entries={decorations}
                    props={{ message: m }}
                  />
                )}
                {!compact && <MessageMeta message={m} variant="header" />}
              </span>
            )}
            {editing ? (
              <MessageEditor message={m} />
            ) : m.deleted ? (
              <p className={styles.deleted}>
                {m.deletedBy
                  ? `This message was deleted by ${m.deletedBy === selfId ? 'you' : nameFor(m.deletedBy)} (admin).`
                  : 'This message was deleted.'}
              </p>
            ) : (
              m.body !== '' && (
                <MessageBody
                  className={styles.body}
                  body={m.body}
                  ranges={m.ranges}
                  selfId={selfId}
                  nameFor={nameFor}
                  trailing={m.editedAt !== undefined ? <EditedTag editedAt={m.editedAt} /> : null}
                  renderMention={(contactId, pill) => (
                    <AuthorPopover contactId={contactId} conversationId={conversationId} side="top">
                      {pill}
                    </AuthorPopover>
                  )}
                />
              )
            )}
            {!editing && !m.deleted && <MessageNotes message={m} nameFor={nameFor} />}
            {m.attachments.length > 0 && (
              <Attachments
                conversationId={conversationId}
                attachments={m.attachments}
                pending={pending}
                caption={name}
              />
            )}
            {m.reactions.length > 0 && (
              <Reactions
                reactions={m.reactions}
                selfId={selfId}
                nameFor={nameFor}
                onToggle={(emoji) => {
                  act.toggleReaction(app, m, emoji);
                }}
                onAdd={(emoji) => {
                  act.react(app, m, emoji);
                }}
              />
            )}
            {accessories.length > 0 && (
              <Slot name="message.accessories" entries={accessories} props={{ message: m }} />
            )}
          </div>
          {active && !editing && m.kind === 'normal' && (
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
        </div>
      </ContextMenu>
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
    </>
  );
});
