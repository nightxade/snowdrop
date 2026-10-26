import type { ReactNode } from 'react';
import type { ConversationId, ConversationView } from '@/core/domain';
import { useAvatarSrc } from '@/ui/hooks';
import { Avatar, type AvatarSize } from '@/ui/primitives';
import { useGroupAvatarHold } from './avatarHold';
import { PersonAvatar } from './PersonAvatar';
import { conversationAvatar, useConversationView, usePeer } from './useConversation';

export function ConversationAvatar({
  conversation,
  size = 32,
  status,
  revealable = false,
}: {
  conversation: ConversationView;
  size?: AvatarSize;
  status?: ReactNode;
  /** Offer "View photo" in place of a hidden stranger's picture (large avatars only). */
  revealable?: boolean;
}) {
  const peer = usePeer(conversation);
  const look = conversationAvatar(conversation, peer);
  if (conversation.kind === 'direct' && peer) {
    return (
      <PersonAvatar
        contactId={peer.id}
        conversationId={conversation.id}
        fallback={look.fallback}
        color={look.color}
        shape={look.shape}
        size={size}
        status={status}
        revealable={revealable}
      />
    );
  }
  return <GroupLikeAvatar conversation={conversation} look={look} size={size} status={status} />;
}

/** `ConversationAvatar` for a conversation known only by id (a search or switcher result). */
export function ConversationAvatarById({
  id,
  size = 24,
}: {
  id: ConversationId;
  size?: AvatarSize;
}) {
  const conversation = useConversationView(id);
  return conversation ? <ConversationAvatar conversation={conversation} size={size} /> : null;
}

/** A group (or a direct chat whose person isn't known yet). */
function GroupLikeAvatar({
  conversation,
  look,
  size,
  status,
}: {
  conversation: ConversationView;
  look: ReturnType<typeof conversationAvatar>;
  size: AvatarSize;
  status: ReactNode;
}) {
  const held = useGroupAvatarHold(conversation.id);
  const [ref, src] = useAvatarSrc('group', conversation.kind === 'group' ? conversation.id : null, {
    version: conversation.avatarVersion,
    known: look.src,
    held,
  });
  return (
    <Avatar
      ref={ref}
      src={src}
      fallback={look.fallback}
      color={look.color}
      shape={look.shape}
      size={size}
      status={status}
    />
  );
}
