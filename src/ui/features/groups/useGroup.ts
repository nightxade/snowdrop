import { useStore } from 'zustand';
import {
  canAddMembers,
  canEditGroupInfo,
  canManageGroup,
  type Contact,
  type Conversation,
  type ConversationId,
} from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';

export interface GroupAccess {
  /** Undefined when the group isn't (or is no longer) known. */
  group: Conversation | undefined;
  selfId: string | null;
  /** Name, photo and description. */
  canEdit: boolean;
  canAdd: boolean;
  /** Admin: remove people, make admins, answer requests, the link and the rules. */
  canManage: boolean;
}

/** The group and what our role may do in it; re-renders when either changes. */
export function useGroup(conversationId: ConversationId): GroupAccess {
  const stores = useStores();
  const found = useStore(stores.conversations, (s) => s.byId[conversationId]);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const group = found?.kind === 'group' ? found : undefined;
  return {
    group,
    selfId,
    canEdit: canEditGroupInfo(group, selfId),
    canAdd: canAddMembers(group, selfId),
    canManage: canManageGroup(group, selfId),
  };
}

/** A person's name for a list or sentence; contacts we have never heard of read as strangers. */
export function nameOf(contacts: Readonly<Record<string, Contact>>, id: string): string {
  return contacts[id]?.name ?? 'Unknown contact';
}
