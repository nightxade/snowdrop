import type { ReactElement } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { contactsSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { ProfileTrigger } from '@/ui/features/members';

/** Wraps a name/avatar/mention so clicking it opens the person's profile (popout, or a sheet on phones). */
export function AuthorPopover({
  contactId,
  conversationId,
  children,
  side = 'right',
}: {
  contactId: string;
  conversationId: ConversationId;
  children: ReactElement;
  side?: 'right' | 'top';
}) {
  const stores = useStores();
  const contact = useStore(stores.contacts, contactsSelectors.contact(contactId));
  if (!contact) return children;
  return (
    <ProfileTrigger
      contact={contact}
      conversationId={conversationId}
      side={side}
      trigger={children}
    />
  );
}
