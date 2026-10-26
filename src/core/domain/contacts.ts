/**
 * Which contacts can be chosen for a new chat or a group: the shared rule
 * behind the New message list and the group pickers.
 */
import type { Contact } from './types';

/** Contacts a message can go to: not us, blocked, hidden by the phone or no longer on Signal. */
export function composableContacts(
  contacts: Readonly<Record<string, Contact>>,
  selfId: string | null,
): Contact[] {
  return Object.values(contacts)
    .filter((c) => !c.isSelf && c.id !== selfId && !c.blocked && !c.hidden && !c.unregistered)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}
