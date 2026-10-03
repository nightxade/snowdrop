import { Copy, IdCard, MessageSquare } from 'lucide-react';
import type { Contact, ConversationId } from '@/core/domain';
import type { AppServices } from '@/ui/hooks';
import {
  copyText,
  formatPhone,
  openDirectConversation,
  pluginMenuEntries,
} from '@/ui/features/conversation';
import type { MenuEntry } from '@/ui/primitives';

const ICON = 16;

/**
 * The member row's context menu: open the profile, message them, copy the
 * number, then plugin items registered with `ctx.menus.add('member', …)`.
 */
export function memberMenu(
  app: AppServices,
  contact: Contact,
  conversationId: ConversationId,
  openProfile: () => void,
): MenuEntry[] {
  const plugin = pluginMenuEntries(
    app.registries.menus.member.list(),
    { contact, conversationId },
    app.registries,
  );
  return [
    {
      kind: 'item',
      id: 'profile',
      label: 'Profile',
      icon: <IdCard size={ICON} />,
      onSelect: openProfile,
    },
    ...(!contact.isSelf
      ? [
          {
            kind: 'item',
            id: 'message',
            label: 'Message',
            icon: <MessageSquare size={ICON} />,
            onSelect: () => {
              openDirectConversation(app, contact);
            },
          } as const,
        ]
      : []),
    ...(contact.number
      ? [
          {
            kind: 'item',
            id: 'copy-number',
            label: 'Copy phone number',
            icon: <Copy size={ICON} />,
            onSelect: () => {
              void copyText(app, formatPhone(contact.number ?? ''), 'phone number');
            },
          } as const,
        ]
      : []),
    ...(plugin.length > 0 ? [{ kind: 'separator', id: 's-plugins' } as const, ...plugin] : []),
  ];
}
