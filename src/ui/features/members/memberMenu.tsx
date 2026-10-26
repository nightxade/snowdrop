import { Copy, IdCard, MessageSquare, ShieldCheck, ShieldOff, UserMinus } from 'lucide-react';
import { canManageGroup, type Contact, type ConversationId } from '@/core/domain';
import type { AppServices } from '@/ui/hooks';
import {
  copyText,
  formatPhone,
  openDirectConversation,
  openGroupModal,
  pluginMenuEntries,
} from '@/ui/features/conversation';
import type { MenuEntry } from '@/ui/primitives';

const ICON = 16;

/**
 * The member row's context menu: open the profile, message them, copy the
 * number, what an admin can do to them (make or remove admin, remove from the
 * group), then plugin items registered with `ctx.menus.add('member', …)`.
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
  const group = app.stores.conversations.getState().byId[conversationId];
  const selfId = app.stores.session.getState().self?.id ?? null;
  const admin = group?.adminIds.includes(contact.id) === true;
  const manage = (action: 'remove' | 'make-admin' | 'remove-admin') => () => {
    openGroupModal(app, 'groupMemberAction', { conversationId, memberId: contact.id, action });
  };
  // Admin-only, and only on someone else: leaving is its own action.
  const admins: MenuEntry[] =
    !contact.isSelf && canManageGroup(group, selfId)
      ? [
          { kind: 'separator', id: 's-admin' },
          admin
            ? {
                kind: 'item',
                id: 'remove-admin',
                label: 'Remove as admin',
                icon: <ShieldOff size={ICON} />,
                onSelect: manage('remove-admin'),
              }
            : {
                kind: 'item',
                id: 'make-admin',
                label: 'Make admin',
                icon: <ShieldCheck size={ICON} />,
                onSelect: manage('make-admin'),
              },
          {
            kind: 'item',
            id: 'remove-member',
            label: 'Remove from group',
            icon: <UserMinus size={ICON} />,
            danger: true,
            onSelect: manage('remove'),
          },
        ]
      : [];
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
    ...admins,
    ...(plugin.length > 0 ? [{ kind: 'separator', id: 's-plugins' } as const, ...plugin] : []),
  ];
}
