import { Clock } from 'lucide-react';
import type { CSSProperties, ReactElement } from 'react';
import { useStore } from 'zustand';
import { initialsFor, type ConversationId, type Message } from '@/core/domain';
import { contactsSelectors } from '@/core/stores';
import { useObservableList, useSnowdrop } from '@/ui/hooks';
import { Avatar, Slot, VisuallyHidden } from '@/ui/primitives';
import * as act from './actions';
import { Attachments } from './Attachments';
import { AuthorPopover } from './AuthorPopover';
import { EditedTag } from './EditedTag';
import { LinkPreviewCard } from './LinkPreviewCard';
import { MessageBody } from './MessageBody';
import { MessageEditor } from './MessageEditor';
import { MessageMeta } from './MessageMeta';
import { MessageNotes } from './MessageNotes';
import { PollCard, type PollCardMode } from './PollCard';
import { Reactions } from './Reactions';
import { CustomEmojiPopover } from './CustomEmojiPopover';
import { StickerBubble } from './StickerBubble';
import { useCustomEmojiResolver } from './useCustomEmojiResolver';
import { useIncomingMediaHeld } from './useMediaHold';
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
  /** The row's context menu is open: no tooltips over it. */
  menuOpen?: boolean;
  /** Id for the row's aria-describedby. */
  bodyId: string;
  onEditDone: () => void;
  /** Opens the sticker's pack dialog; omitted when the backend can't show packs. */
  onOpenStickerPack?: (() => void) | undefined;
  /** Opens the poll's "Poll details" dialog, which the row renders outside itself. */
  onViewPollVotes?: (() => void) | undefined;
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
  menuOpen = false,
  bodyId,
  onEditDone,
  onOpenStickerPack,
  onViewPollVotes,
}: MessageContentProps) {
  const app = useSnowdrop();
  const author = useStore(app.stores.contacts, contactsSelectors.contact(m.authorId));
  const accessories = useObservableList(app.registries.messageAccessories);
  const decorations = useObservableList(app.registries.messageDecorations);
  const name = nameFor(m.authorId);
  const color = author?.color ?? 'var(--snowdrop-avatar-1)';
  const preview = m.previews?.[0];
  const showHeader = compact || !continuation;
  const { resolveCustomEmoji, emojiSources } = useCustomEmojiResolver(m, selfId, conversationId);
  // A message request's links are text until it is accepted.
  const linksEnabled = !useIncomingMediaHeld(conversationId, m.authorId);
  // Emoji someone else delivered can be added to your own collection.
  const delivered = m.authorId === selfId ? undefined : m.customEmoji;

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
        {!compact && !showHeader && <MessageMeta message={m} variant="gutter" quiet={menuOpen} />}
        {compact && <MessageMeta message={m} variant="compact" quiet={menuOpen} />}
      </div>
      <div className={styles.content} data-snowdrop="message-content">
        {showHeader && (
          <span className={styles.header}>
            {compact && compactAvatars && <span className={styles.compactAvatar}>{avatar}</span>}
            <AuthorPopover contactId={m.authorId} conversationId={conversationId}>
              <button
                type="button"
                className={styles.name}
                data-snowdrop="message-author"
                title={name}
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
            {!compact && <MessageMeta message={m} variant="header" quiet={menuOpen} />}
          </span>
        )}
        {emojiSources}
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
              linksEnabled={linksEnabled}
              {...(resolveCustomEmoji ? { resolveCustomEmoji } : {})}
              {...(delivered?.length
                ? {
                    renderCustomEmoji: (emojiName: string, image: ReactElement) => {
                      const delivery = delivered.find((d) => d.name === emojiName);
                      return delivery ? (
                        <CustomEmojiPopover conversationId={conversationId} delivery={delivery}>
                          {image}
                        </CustomEmojiPopover>
                      ) : (
                        image
                      );
                    },
                  }
                : {})}
              trailing={
                <>
                  {m.editedAt !== undefined && <EditedTag editedAt={m.editedAt} />}
                  {pending && <PendingMark />}
                </>
              }
              renderMention={(contactId, pill) => (
                <AuthorPopover contactId={contactId} conversationId={conversationId} side="top">
                  {pill}
                </AuthorPopover>
              )}
            />
          )
        )}
        {pending && m.body === '' && !editing && <PendingMark />}
        {!editing && !m.deleted && <MessageNotes message={m} nameFor={nameFor} />}
        {!editing && !m.deleted && preview && (
          <LinkPreviewCard
            conversationId={conversationId}
            message={m}
            preview={preview}
            body={m.body}
          />
        )}
        {m.attachments.length > 0 && (
          <Attachments
            conversationId={conversationId}
            message={m}
            messageId={m.id}
            attachments={m.attachments}
            pending={pending}
            caption={name}
          />
        )}
        {!m.deleted && m.sticker && (
          <StickerBubble
            conversationId={conversationId}
            authorId={m.authorId}
            sticker={m.sticker}
            onOpen={onOpenStickerPack}
          />
        )}
        {!m.deleted && m.poll && (
          <PollCard
            id={bodyId}
            poll={m.poll}
            mode={pollMode(act.permissionsFor(app, m))}
            selfId={selfId}
            onVote={(optionIndexes) => act.votePoll(app, m, optionIndexes)}
            onViewVotes={() => {
              onViewPollVotes?.();
            }}
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

/** Whether the card lets the user answer, shows an unsent poll's options, or only shows the poll. */
function pollMode(p: act.MessagePermissions): PollCardMode {
  if (p.canVotePoll) return 'vote';
  return p.pending || p.failed ? 'pending' : 'view';
}

/** Small clock after a message that hasn't left yet; screen readers hear "Sending". */
function PendingMark() {
  return (
    <span className={styles.pendingMark}>
      <Clock size={12} aria-hidden />
      <VisuallyHidden>Sending</VisuallyHidden>
    </span>
  );
}

function deletedText(m: Message, selfId: string | null, nameFor: (id: string) => string): string {
  if (m.deletedBy !== undefined) {
    return `This message was deleted by ${m.deletedBy === selfId ? 'you' : nameFor(m.deletedBy)} (admin).`;
  }
  return m.authorId === selfId ? 'You deleted this message.' : 'This message was deleted.';
}
