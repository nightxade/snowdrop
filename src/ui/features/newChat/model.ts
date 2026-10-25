/**
 * What the New message dialog lists for a search: existing contacts that
 * match, plus "Find by phone number" / "Find by username" when the text is
 * one. The rules follow Signal Desktop's compose list: a number that is
 * already a contact is shown as that contact rather than offered again.
 */
import {
  classifyRecipientInput,
  fuzzyMatch,
  type Contact,
  type RecipientQuery,
} from '@/core/domain';

export interface ContactMatch {
  contact: Contact;
  /** Matched UTF-16 positions in `contact.name`, for highlighting. */
  indices: number[];
}

export interface NewMessageSearch {
  contacts: ContactMatch[];
  /** The lookup on offer, if the text is a number (not yet a contact) or a username. */
  find: RecipientQuery | null;
  /** Looks like a phone number but has no country code to read it with. */
  needsCountryCode: boolean;
}

const digitsOf = (text: string): string => text.replace(/\D/gu, '');

/** Contacts a message can go to: not us, blocked, hidden by the phone or no longer on Signal. */
export function composableContacts(
  contacts: Readonly<Record<string, Contact>>,
  selfId: string | null,
): Contact[] {
  return Object.values(contacts)
    .filter((c) => !c.isSelf && c.id !== selfId && !c.blocked && !c.hidden && !c.unregistered)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function searchNewMessage(
  query: string,
  contacts: readonly Contact[],
  selfNumber: string | undefined,
): NewMessageSearch {
  const text = query.trim();
  if (text === '') {
    return {
      contacts: contacts.map((contact) => ({ contact, indices: [] })),
      find: null,
      needsCountryCode: false,
    };
  }
  const { phone, username, needsCountryCode } = classifyRecipientInput(text, selfNumber);
  let matches: ContactMatch[];
  if (phone) {
    matches = contacts
      .filter((c) => c.number === phone)
      .map((contact) => ({ contact, indices: [] }));
  } else if (username) {
    // A username is not in the contact list; only the lookup can resolve it.
    matches = [];
  } else {
    const digits = digitsOf(text);
    const numeric = /^[\d\s+().-]+$/u.test(text) && digits.length >= 3;
    const scored: (ContactMatch & { score: number })[] = [];
    for (const contact of contacts) {
      const byName = fuzzyMatch(text, contact.name);
      if (byName) {
        scored.push({ contact, indices: byName.indices, score: byName.score });
      } else if (numeric && contact.number && digitsOf(contact.number).includes(digits)) {
        scored.push({ contact, indices: [], score: 0 });
      }
    }
    scored.sort((a, b) => b.score - a.score || a.contact.name.localeCompare(b.contact.name));
    matches = scored.map(({ contact, indices }) => ({ contact, indices }));
  }
  const find: RecipientQuery | null = username
    ? { kind: 'username', username }
    : phone && matches.length === 0
      ? { kind: 'phone', e164: phone }
      : null;
  return { contacts: matches, find, needsCountryCode };
}
