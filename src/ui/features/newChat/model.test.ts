import { describe, expect, it } from 'vitest';
import type { Contact } from '@/core/domain';
import { composableContacts, searchNewMessage } from './model';

const contact = (id: string, name: string, extra: Partial<Contact> = {}): Contact => ({
  id,
  name,
  color: 'x',
  ...extra,
});

const ADA = contact('a', 'Ada Lovelace', { number: '+442071234567' });
const BEN = contact('b', 'Ben Franklin', { number: '+12025550123' });
const CAL = contact('c', 'Cal Newport');
const all = [ADA, BEN, CAL];
const US = '+12025550100';

describe('composableContacts', () => {
  it('drops us, blocked, hidden and unregistered people, and sorts by name', () => {
    const list = composableContacts(
      {
        z: contact('z', 'Zed'),
        me: contact('me', 'Me', { isSelf: true }),
        b: contact('b', 'Blocked', { blocked: true }),
        h: contact('h', 'Hidden', { hidden: true }),
        u: contact('u', 'Gone', { unregistered: true }),
        a: contact('a', 'Amy'),
      },
      'me',
    );
    expect(list.map((c) => c.name)).toEqual(['Amy', 'Zed']);
    expect(composableContacts({ s: contact('s', 'S') }, 's')).toEqual([]);
  });
});

describe('searchNewMessage', () => {
  it('lists every contact for an empty search, with no lookup on offer', () => {
    const r = searchNewMessage('  ', all, US);
    expect(r.contacts.map((m) => m.contact.id)).toEqual(['a', 'b', 'c']);
    expect(r.find).toBeNull();
  });

  it('filters by name with the matched letters, best match first', () => {
    const r = searchNewMessage('ben', all, US);
    expect(r.contacts.map((m) => m.contact.id)).toEqual(['b']);
    expect(r.contacts[0]?.indices).toEqual([0, 1, 2]);
    expect(r.find).toBeNull();
    expect(searchNewMessage('zzz', all, US).contacts).toEqual([]);
  });

  it('matches a partial number against the numbers of contacts', () => {
    expect(searchNewMessage('555 01', all, US).contacts.map((m) => m.contact.id)).toEqual(['b']);
    expect(searchNewMessage('+44 20', all, US).contacts.map((m) => m.contact.id)).toEqual(['a']);
  });

  it('offers Find by phone number for a full number nobody has, normalised', () => {
    expect(searchNewMessage('+1 (202) 555-0190', all, US)).toMatchObject({
      contacts: [],
      find: { kind: 'phone', e164: '+12025550190' },
    });
    // A national number is read in the user's own (NANP) region.
    expect(searchNewMessage('(202) 555-0190', all, US).find).toEqual({
      kind: 'phone',
      e164: '+12025550190',
    });
    expect(searchNewMessage('(202) 555-0190', all, '+447911123456').find).toBeNull();
  });

  it('shows a number that is already a contact as that contact, with no lookup', () => {
    const r = searchNewMessage('+1 202 555 0123', all, US);
    expect(r.contacts.map((m) => m.contact.id)).toEqual(['b']);
    expect(r.find).toBeNull();
  });

  it('offers Find by username for name.123, with or without @', () => {
    expect(searchNewMessage('@carol.42', all, US)).toMatchObject({
      contacts: [],
      find: { kind: 'username', username: 'carol.42' },
    });
    expect(searchNewMessage('carol.42', all, US).find).toEqual({
      kind: 'username',
      username: 'carol.42',
    });
    expect(searchNewMessage('carol', all, US).find).toBeNull();
  });

  it('says when a number needs its country code', () => {
    expect(searchNewMessage('07911 123456', all, '+447911123456').needsCountryCode).toBe(true);
    expect(searchNewMessage('Ben', all, US).needsCountryCode).toBe(false);
  });
});
