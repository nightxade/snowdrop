import { Ban, CircleSlash } from 'lucide-react';
import type { ConversationId } from '@/core/domain';
import type { AppServices } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';
import { openBlockDialog } from './actions';
import { canBlock, readBlockTarget } from './blocking';

const ICON = 16;

/**
 * Block or Unblock for a person (their direct-chat id) or a group, as a menu
 * item that asks first (`BlockDialog`). Nothing for yourself, for something
 * unknown, or when the backend can't block. Wording as in Signal Desktop:
 * "Block group" / "Unblock group" for a group, "Block" / "Unblock" for a person.
 */
export function blockMenuEntries(app: AppServices, id: ConversationId): MenuEntry[] {
  if (!canBlock(app)) return [];
  const target = readBlockTarget(app, id);
  if (!target || target.self) return [];
  const noun = target.group ? ' group' : '';
  return [
    {
      kind: 'item',
      id: 'block',
      label: `${target.blocked ? 'Unblock' : 'Block'}${noun}`,
      icon: target.blocked ? <CircleSlash size={ICON} /> : <Ban size={ICON} />,
      ...(target.blocked ? {} : { danger: true }),
      onSelect: () => {
        openBlockDialog(app, id, target.blocked);
      },
    },
  ];
}
