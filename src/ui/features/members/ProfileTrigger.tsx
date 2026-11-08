import { cloneElement, useRef, useState, type MouseEvent, type ReactElement } from 'react';
import type { Contact, ConversationId } from '@/core/domain';
import { BREAKPOINTS, focusConversation, useMediaQuery, useSnowdrop } from '@/ui/hooks';
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
  const app = useSnowdrop();
  const sheet = useMediaQuery(BREAKPOINTS.drawer);
  const [open, setOpen] = useState(false);
  /** The chat the card opened (its "Message" button): focus goes there when the card has closed. */
  const opened = useRef<ConversationId | null>(null);
  const focusOpened = (): boolean => {
    const id = opened.current;
    opened.current = null;
    if (!id) return false;
    focusConversation(id, app.stores.settings.getState().behaviour.focusComposerOnOpen);
    return true;
  };
  const label = `${contact.name}'s profile`;
  const card = (
    <ProfilePopout
      contact={contact}
      conversationId={conversationId}
      variant={sheet ? 'sheet' : 'popout'}
      onClose={(openedChat) => {
        opened.current = openedChat ?? null;
        setOpen(false);
        // The sheet gives focus back to its opener a frame and a tick after it
        // closes, but only if focus is still inside it then (see `Drawer`): moving
        // focus to the opened chat now makes it leave focus where it is.
        if (sheet) focusOpened();
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
      onCloseAutoFocus={(e) => {
        if (focusOpened()) e.preventDefault();
      }}
    >
      {card}
    </Popover>
  );
}
