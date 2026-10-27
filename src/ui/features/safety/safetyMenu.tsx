import { ShieldCheck } from 'lucide-react';
import type { Contact } from '@/core/domain';
import type { AppServices } from '@/ui/hooks';
import type { MenuEntry } from '@/ui/primitives';
import { canViewSafetyNumber, openSafetyNumber } from './actions';

/** "View safety number" for a person's menu; nothing for yourself or a backend without safety numbers. */
export function safetyNumberMenuEntries(app: AppServices, contact: Contact): MenuEntry[] {
  if (!canViewSafetyNumber(app, contact)) return [];
  return [
    {
      kind: 'item',
      id: 'safety-number',
      label: 'View safety number',
      icon: <ShieldCheck size={16} />,
      onSelect: () => {
        openSafetyNumber(app, contact.id);
      },
    },
  ];
}
