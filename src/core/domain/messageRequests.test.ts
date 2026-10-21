import { describe, expect, it } from 'vitest';
import { directConversationId, groupConversationId, type Contact } from './index';
import {
  isConversationAccepted,
  isConversationBlocked,
  isTrustedContact,
  messageRequestState,
  type MessageRequestFacts,
} from './messageRequests';

const SELF = 'self';
const contact = (id: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  name: id,
  color: '#000',
  ...extra,
});

function facts(contacts: Contact[], extra: Partial<MessageRequestFacts> = {}): MessageRequestFacts {
  const byId = new Map(contacts.map((c) => [c.id, c]));
  return { selfId: SELF, contact: (id) => byId.get(id), acceptedHere: false, ...extra };
}

const dm = (peer: string) => ({
  id: directConversationId(peer),
  memberIds: [SELF, peer],
});
const group = (...members: string[]) => ({
  id: groupConversationId('g'),
  memberIds: [SELF, ...members],
});

describe('trusted contacts', () => {
  it('is the user, someone saved on the phone, or someone the user shares a profile with', () => {
    expect(isTrustedContact(contact('a', { isSelf: true }))).toBe(true);
    expect(isTrustedContact(contact('a', { inContacts: true }))).toBe(true);
    expect(isTrustedContact(contact('a', { profileSharing: true }))).toBe(true);
    expect(isTrustedContact(contact('a'))).toBe(false);
    expect(isTrustedContact(undefined)).toBe(false);
  });
});

describe('isConversationAccepted: direct chats', () => {
  it('accepts a saved contact', () => {
    expect(isConversationAccepted(dm('a'), facts([contact('a', { inContacts: true })]))).toBe(true);
  });

  it('accepts someone the user shares a profile with (chatted with, or accepted elsewhere)', () => {
    expect(isConversationAccepted(dm('a'), facts([contact('a', { profileSharing: true })]))).toBe(
      true,
    );
  });

  it('does not accept a stranger, a profile-name-only contact, or someone unknown', () => {
    expect(isConversationAccepted(dm('a'), facts([contact('a', { profileName: 'A' })]))).toBe(
      false,
    );
    expect(isConversationAccepted(dm('a'), facts([]))).toBe(false);
  });

  it('accepts the note to self', () => {
    expect(isConversationAccepted(dm(SELF), facts([]))).toBe(true);
  });

  it('accepts anything accepted here: sent a message, pressed Accept, or grandfathered', () => {
    expect(isConversationAccepted(dm('a'), facts([], { acceptedHere: true }))).toBe(true);
    expect(isConversationAccepted(group('a'), facts([], { acceptedHere: true }))).toBe(true);
  });
});

describe('isConversationAccepted: groups', () => {
  it('accepts a group with a trusted contact in it', () => {
    const known = facts([contact('a'), contact('b', { inContacts: true })]);
    expect(isConversationAccepted(group('a', 'b'), known)).toBe(true);
  });

  it('does not accept a group of strangers, or one where only the user is trusted', () => {
    expect(isConversationAccepted(group('a', 'b'), facts([contact('a'), contact('b')]))).toBe(
      false,
    );
    expect(isConversationAccepted(group(), facts([contact(SELF, { isSelf: true })]))).toBe(false);
  });
});

describe('blocked', () => {
  it('reads the peer for a direct chat and the group itself for a group', () => {
    const blockedPeer = (id: string) => (id === 'a' ? contact('a', { blocked: true }) : undefined);
    expect(isConversationBlocked(dm('a'), blockedPeer)).toBe(true);
    expect(isConversationBlocked(dm('b'), blockedPeer)).toBe(false);
    expect(isConversationBlocked({ ...group('a'), blocked: true }, () => undefined)).toBe(true);
    expect(isConversationBlocked(group('a'), () => undefined)).toBe(false);
  });

  it('wins over every other reason a chat would be accepted', () => {
    const all = facts([contact('a', { inContacts: true, profileSharing: true, blocked: true })], {
      acceptedHere: true,
    });
    expect(messageRequestState(dm('a'), all)).toBe('blocked');
  });
});

describe('messageRequestState', () => {
  it('is request, accepted or blocked', () => {
    expect(messageRequestState(dm('a'), facts([contact('a')]))).toBe('request');
    expect(messageRequestState(dm('a'), facts([contact('a', { inContacts: true })]))).toBe(
      'accepted',
    );
    expect(messageRequestState({ ...group('a'), blocked: true }, facts([]))).toBe('blocked');
  });

  it('treats an unparseable id as accepted rather than withholding from something unknown', () => {
    expect(isConversationAccepted({ id: 'nonsense' as never, memberIds: [] }, facts([]))).toBe(
      true,
    );
  });
});
