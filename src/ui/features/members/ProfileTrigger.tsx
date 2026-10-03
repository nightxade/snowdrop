import { cloneElement, useState, type MouseEvent, type ReactElement } from 'react';
import type { Contact, ConversationId } from '@/core/domain';
import { BREAKPOINTS, useMediaQuery } from '@/ui/hooks';
import { Drawer, Popover } from '@/ui/primitives';
import { ProfilePopout } from './ProfilePopout';

type TriggerProps = {
  onClick?: (e: MouseEvent<HTMLElement>) => void;
  'aria-haspopup'?: 'dialog';
  'aria-expanded'?: boolean;
  'data-state'?: 'open' | 'closed';
};

/**
 * Opens a contact's profile from `trigger` (a member row, an author name or
 * avatar, a mention): a popout beside it on wide screens (flipping and
 * shifting to stay on screen), a bottom sheet on phones, where a 320px card
 * can't sit beside anything without being clipped.
 */
export function ProfileTrigger({
  contact,
  conversationId,
  trigger,
  side = 'right',
  sideOffset = 8,
}: {
  contact: Contact;
  conversationId?: ConversationId | undefined;
  trigger: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
  sideOffset?: number;
}) {
  const sheet = useMediaQuery(BREAKPOINTS.drawer);
  const [open, setOpen] = useState(false);
  const label = `${contact.name}'s profile`;
  const card = (
    <ProfilePopout
      contact={contact}
      conversationId={conversationId}
      variant={sheet ? 'sheet' : 'popout'}
      onClose={() => {
        setOpen(false);
      }}
    />
  );
  if (sheet) {
    const own = (trigger.props as TriggerProps).onClick;
    return (
      <>
        {cloneElement(trigger as ReactElement<TriggerProps>, {
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'data-state': open ? 'open' : 'closed',
          onClick: (e: MouseEvent<HTMLElement>) => {
            own?.(e);
            if (!e.defaultPrevented) setOpen(true);
          },
        })}
        <Drawer side="bottom" open={open} onOpenChange={setOpen} label={label}>
          {card}
        </Drawer>
      </>
    );
  }
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side={side}
      align="start"
      sideOffset={sideOffset}
      flush
      label={label}
      trigger={trigger}
    >
      {card}
    </Popover>
  );
}
