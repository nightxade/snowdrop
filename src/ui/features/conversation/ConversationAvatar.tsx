import type { ReactNode } from 'react';
import type { ConversationView } from '@/core/domain';
import { Avatar, type AvatarSize } from '@/ui/primitives';
import { conversationAvatar, usePeer } from './useConversation';

export function ConversationAvatar({
  conversation,
  size = 32,
  status,
}: {
  conversation: ConversationView;
  size?: AvatarSize;
  status?: ReactNode;
}) {
  const peer = usePeer(conversation);
  const look = conversationAvatar(conversation, peer);
  return (
    <Avatar
      src={look.src}
      fallback={look.fallback}
      color={look.color}
      shape={look.shape}
      size={size}
      status={status}
    />
  );
}
