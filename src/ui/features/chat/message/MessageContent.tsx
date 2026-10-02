import type { CSSProperties } from 'react';
import { useStore } from 'zustand';
import { initialsFor, type ConversationId, type Message } from '@/core/domain';
import { contactsSelectors } from '@/core/stores';
import { useObservableList, useShrike } from '@/ui/hooks';
import { Avatar, Slot } from '@/ui/primitives';
import * as act from './actions';
import { Attachments } from './Attachments';
import { AuthorPopover } from './AuthorPopover';
import { EditedTag } from './EditedTag';
import { MessageBody } from './MessageBody';
import { MessageEditor } from './MessageEditor';
import { MessageMeta } from './MessageMeta';
import { MessageNotes } from './MessageNotes';
import { Reactions } from './Reactions';
import styles from './MessageItem.module.css';

export interface MessageContentProps {
  message: Message;
  conversationId: ConversationId;
  nameFor: (id: string) => string;
  selfId: string | null;
  compact: boolean;
  compactAvatars: boolean;
  continuation: boolean;
  editing: boolean;
  pending: boolean;
  /** Id for the row's aria-describedby. */
  bodyId: string;
  onEditDone: () => void;
}

/** Gutter (avatar / hover time) and content column of a message row. */
export function MessageContent({
  message: m,
  conversationId,
  nameFor,
  selfId,
  compact,
  compactAvatars,
  continuation,
  editing,
  pending,
  bodyId,
  onEditDone,
}: MessageContentProps) {
  const app = useShrike();
  const author = useStore(app.stores.contacts, contactsSelectors.contact(m.authorId));
  const accessories = useObservableList(app.registries.messageAccessories);
  const decorations = useObservableList(app.registries.messageDecorations);
  const name = nameFor(m.authorId);
  const color = author?.color ?? 'var(--shrike-avatar-1)';
  const showHeader = compact || !continuation;

  const avatar = (
    <Avatar
      size={compact ? 16 : 40}
      {...(author?.avatarUrl ? { src: author.avatarUrl } : {})}
      fallback={compact ? '' : initialsFor(name)}
      color={color}
    />
  );

  return (
    <>
      <div className={styles.gutter}>
        {!compact && showHeader && (
          <AuthorPopover contactId={m.authorId} conversationId={conversationId}>
            <button type="button" className={styles.avatarButton} aria-label={`${name}'s profile`}>
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
            {compact && compactAvatars && <span className={styles.compactAvatar}>{avatar}</span>}
            <AuthorPopover contactId={m.authorId} conversationId={conversationId}>
              <button
                type="button"
                className={styles.name}
                style={{ '--name-color': color } as CSSProperties}
              >
                {name}
              </button>
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
          <MessageEditor message={m} onDone={onEditDone} />
        ) : m.deleted ? (
          <p className={styles.deleted} id={bodyId}>
            {deletedText(m, selfId, nameFor)}
          </p>
        ) : (
          m.body !== '' && (
            <MessageBody
              id={bodyId}
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
    </>
  );
}

function deletedText(m: Message, selfId: string | null, nameFor: (id: string) => string): string {
  if (m.deletedBy !== undefined) {
    return `This message was deleted by ${m.deletedBy === selfId ? 'you' : nameFor(m.deletedBy)} (admin).`;
  }
  return m.authorId === selfId ? 'You deleted this message.' : 'This message was deleted.';
}
