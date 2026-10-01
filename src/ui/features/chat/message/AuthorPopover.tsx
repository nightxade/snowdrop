import { useState, type ReactElement } from 'react';
import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { contactsSelectors } from '@/core/stores';
import { useStores } from '@/ui/hooks';
import { ProfilePopout } from '@/ui/features/members';
import { Popover } from '@/ui/primitives';

/** Wraps a name/avatar/mention so clicking it opens the person's profile popout. */
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
  const [open, setOpen] = useState(false);
  if (!contact) return children;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align="start"
      sideOffset={8}
      flush
      label={`${contact.name}'s profile`}
      trigger={children}
    >
      <ProfilePopout
        contact={contact}
        conversationId={conversationId}
        onClose={() => {
          setOpen(false);
        }}
      />
    </Popover>
  );
}
