import { useStore } from 'zustand';
import {
  colorForId,
  initialsFor,
  messageRequestState,
  type Contact,
  type ConversationId,
  type ConversationView,
  type MessageRequestState,
} from '@/core/domain';
import {
  contactsSelectors,
  localSelectors,
  sessionSelectors,
  type ContactsState,
} from '@/core/stores';
import { useStores } from '@/ui/hooks';

/** One conversation with its local state; re-renders only when either changes. */
export function useConversationView(id: ConversationId | null): ConversationView | undefined {
  const stores = useStores();
  const conversation = useStore(stores.conversations, (s) => (id ? s.byId[id] : undefined));
  const local = useStore(stores.local, (s) =>
    id ? localSelectors.conversation(id)(s) : undefined,
  );
  if (!conversation || !local) return undefined;
  return { ...conversation, ...local };
}

/**
 * Whether a conversation is a normal chat, a message request or blocked
 * (core/domain/messageRequests). A conversation the stores don't know is
 * `accepted`: nothing about it is on screen to hold back. Re-renders only
 * when the answer changes, not whenever a contact does.
 */
export function useMessageRequestState(id: ConversationId | null): MessageRequestState {
  const stores = useStores();
  const conversation = useStore(stores.conversations, (s) => (id ? s.byId[id] : undefined));
  const acceptedHere = useStore(stores.local, (s) =>
    id ? s.acceptedChats[id] !== undefined : true,
  );
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  return useStore(stores.contacts, (s: ContactsState) =>
    conversation
      ? messageRequestState(conversation, {
          selfId,
          contact: (contactId) => s.byId[contactId],
          acceptedHere,
        })
      : 'accepted',
  );
}

/** The other participant of a direct conversation. */
export function peerIdOf(
  conversation: { kind: string; memberIds: readonly string[] },
  selfId: string | null,
): string | undefined {
  if (conversation.kind !== 'direct') return undefined;
  return conversation.memberIds.find((m) => m !== selfId) ?? conversation.memberIds[0];
}

export function usePeer(conversation: ConversationView | undefined): Contact | undefined {
  const stores = useStores();
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const peerId = conversation ? peerIdOf(conversation, selfId) : undefined;
  return useStore(stores.contacts, (s: ContactsState) =>
    peerId ? contactsSelectors.contact(peerId)(s) : undefined,
  );
}

export interface AvatarLook {
  src?: string;
  fallback: string;
  color: string;
  shape: 'circle' | 'rounded';
}

/** DMs look like the person; groups get a rounded tile so the two never read alike. */
export function conversationAvatar(
  conversation: Pick<ConversationView, 'id' | 'kind' | 'title' | 'avatarUrl'>,
  peer: Contact | undefined,
): AvatarLook {
  if (conversation.kind === 'direct' && peer) {
    return {
      ...(peer.avatarUrl ? { src: peer.avatarUrl } : {}),
      fallback: initialsFor(peer.name),
      color: peer.color,
      shape: 'circle',
    };
  }
  return {
    ...(conversation.avatarUrl ? { src: conversation.avatarUrl } : {}),
    fallback: initialsFor(conversation.title),
    color: colorForId(conversation.id),
    shape: conversation.kind === 'group' ? 'rounded' : 'circle',
  };
}
