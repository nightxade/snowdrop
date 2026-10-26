// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { groupConversationId, type Contact, type Conversation } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import { DIRECTORY_TTL_MS } from './directory';
import {
  ALICE,
  ALICE_NUMBER,
  BOB,
  BOB_NUMBER,
  GROUP_ID,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from './fixtures/envelopes';
import { SignalCliBackend } from './SignalCliBackend';
import { FakeDaemon, flush, type RpcReply } from './testing';

const JPEG = '/9j/4AAQSkZJRgABAQ==';
const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const JPEG_URL = `data:image/jpeg;base64,${JPEG}`;
const GROUP = groupConversationId(GROUP_ID);
const NOT_FOUND: RpcReply = { error: { code: -1, message: 'Could not find avatar' } };

const person = (uuid: string, number: string, extra: object = {}, profile: object = {}) => ({
  number,
  uuid,
  username: null,
  name: null,
  givenName: null,
  familyName: null,
  nickName: null,
  nickGivenName: null,
  nickFamilyName: null,
  isBlocked: false,
  isHidden: false,
  messageExpirationTime: 0,
  profileSharing: false,
  unregistered: false,
  profile: {
    lastUpdateTimestamp: T0,
    givenName: 'P',
    familyName: null,
    about: null,
    aboutEmoji: null,
    hasAvatar: false,
    ...profile,
  },
  ...extra,
});

const wireGroup = (extra: object = {}) => ({
  id: GROUP_ID,
  name: 'Club',
  isMember: true,
  members: [
    { number: SELF_NUMBER, uuid: SELF_ACI, isAdmin: true },
    { number: ALICE_NUMBER, uuid: ALICE, isAdmin: false },
  ],
  ...extra,
});

function setup(contacts: object[]) {
  const state = { contacts, groups: [wireGroup()] as object[] };
  const daemon = new FakeDaemon()
    .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
    .handle('listContacts', () => ({ result: state.contacts }))
    .handle('listGroups', () => ({ result: state.groups }))
    .reply('updateProfile', {})
    .reply('updateGroup', { timestamp: T0 + 5, groupId: GROUP_ID })
    .handle('getAvatar', () => ({ result: { data: JPEG } }));
  const scheduler = new ManualScheduler(T0 + 1000);
  const backend = new SignalCliBackend({
    baseUrl: '/signal-cli',
    account: null,
    fetch: daemon.fetch,
    clock: scheduler,
    scheduler,
    random: () => 0,
    storage: createMemoryStorage(),
    onAccountSelected: () => undefined,
    debug: () => undefined,
  });
  return { daemon, backend, scheduler, state };
}

async function connected(contacts: object[]) {
  const made = setup(contacts);
  await made.backend.connect();
  await flush();
  return made;
}

const self = person(SELF_ACI, SELF_NUMBER, { profileSharing: true }, { hasAvatar: true });
// A saved contact (it has a name the user's phone gave it) with a profile photo.
const alice = person(
  ALICE,
  ALICE_NUMBER,
  { name: 'Alice', profileSharing: true },
  { hasAvatar: true, lastUpdateTimestamp: T0 + 1 },
);
// Someone who messaged us: no saved name, but a profile photo.
const bob = person(BOB, BOB_NUMBER, {}, { hasAvatar: true });
const carol = person('carol-aci', '+15550003', {}, { hasAvatar: false });

describe('SignalCliBackend avatars', () => {
  it('reads what the profile says about a photo into the contact', async () => {
    const { backend } = await connected([self, alice, bob, carol]);
    const byId = new Map((await backend.listContacts()).map((c) => [c.id, c]));
    expect(byId.get(ALICE)).toMatchObject({ hasAvatar: true, avatarVersion: T0 + 1 });
    expect(byId.get(BOB)).toMatchObject({ hasAvatar: true });
    expect(byId.get('carol-aci')).not.toHaveProperty('hasAvatar');
    expect(byId.get('carol-aci')).not.toHaveProperty('avatarVersion');
    await backend.disconnect();
  });

  it("asks for your own profile photo, a saved contact's own photo before their profile one, a stranger's profile photo only", async () => {
    const { backend, daemon } = await connected([self, alice, bob]);
    await backend.resolveAvatarUrl({ kind: 'contact', id: SELF_ACI });
    await backend.resolveAvatarUrl({ kind: 'contact', id: BOB });
    expect(daemon.callsTo('getAvatar')).toEqual([
      { account: SELF_ACI, profile: SELF_ACI },
      { account: SELF_ACI, profile: BOB },
    ]);
    daemon.calls.length = 0;
    // Alice has no contact photo: the profile photo is the next choice.
    daemon.handle('getAvatar', (params) =>
      params.contact ? NOT_FOUND : { result: { data: PNG } },
    );
    expect(await backend.resolveAvatarUrl({ kind: 'contact', id: ALICE })).toBe(
      `data:image/png;base64,${PNG}`,
    );
    expect(daemon.callsTo('getAvatar')).toEqual([
      { account: SELF_ACI, contact: ALICE },
      { account: SELF_ACI, profile: ALICE },
    ]);
    await backend.disconnect();
  });

  it('asks nobody about someone with no photo, and says so without waiting', async () => {
    const { backend, daemon } = await connected([self, carol]);
    const carolRef = { kind: 'contact', id: 'carol-aci' } as const;
    expect(backend.peekAvatarUrl(carolRef)).toBeNull();
    expect(await backend.resolveAvatarUrl(carolRef)).toBeNull();
    expect(await backend.resolveAvatarUrl({ kind: 'contact', id: 'nobody' })).toBeNull();
    expect(daemon.callsTo('getAvatar')).toEqual([]);
    await backend.disconnect();
  });

  it("asks for a group's picture by its group id", async () => {
    const { backend, daemon } = await connected([self]);
    expect(await backend.resolveAvatarUrl({ kind: 'group', id: GROUP })).toBe(JPEG_URL);
    expect(daemon.callsTo('getAvatar')).toEqual([{ account: SELF_ACI, groupId: GROUP_ID }]);
    expect(backend.peekAvatarUrl({ kind: 'group', id: GROUP })).toBe(JPEG_URL);
    await backend.disconnect();
  });

  it('asks the daemon once however many places show the same person', async () => {
    const { backend, daemon } = await connected([self, bob]);
    const ref = { kind: 'contact', id: BOB } as const;
    await Promise.all([1, 2, 3, 4, 5].map(() => backend.resolveAvatarUrl(ref)));
    await backend.resolveAvatarUrl(ref);
    expect(daemon.callsTo('getAvatar')).toHaveLength(1);
    await backend.disconnect();
  });

  it('keeps the photo you and your groups have across a restart (nothing is kept in the app)', async () => {
    // A brand-new backend with the same daemon: no session state at all.
    const first = await connected([self]);
    await first.backend.disconnect();
    const { backend, daemon } = await connected([self]);
    expect(await backend.resolveAvatarUrl({ kind: 'contact', id: SELF_ACI })).toBe(JPEG_URL);
    expect(await backend.resolveAvatarUrl({ kind: 'group', id: GROUP })).toBe(JPEG_URL);
    expect(daemon.callsTo('getAvatar')).toHaveLength(2);
    await backend.disconnect();
  });

  it('shows no picture, and does not fail, when the daemon has none', async () => {
    const { backend, daemon } = await connected([self, bob]);
    daemon.handle('getAvatar', () => NOT_FOUND);
    expect(await backend.resolveAvatarUrl({ kind: 'contact', id: BOB })).toBeNull();
    expect(await backend.resolveAvatarUrl({ kind: 'group', id: GROUP })).toBeNull();
    await backend.disconnect();
  });

  describe('when a picture may have changed', () => {
    it("forgets a contact's picture once their profile is fetched again with a new version", async () => {
      const { backend, daemon, scheduler, state } = await connected([self, bob]);
      const ref = { kind: 'contact', id: BOB } as const;
      await backend.resolveAvatarUrl(ref);
      expect(backend.peekAvatarUrl(ref)).toBe(JPEG_URL);
      const updates: Contact[] = [];
      backend.on('contactUpdated', (c) => updates.push(c));
      state.contacts = [
        self,
        person(BOB, BOB_NUMBER, {}, { hasAvatar: true, lastUpdateTimestamp: T0 + 99 }),
      ];
      scheduler.advance(DIRECTORY_TTL_MS + 1);
      await backend.listContacts();
      expect(updates.find((c) => c.id === BOB)?.avatarVersion).toBe(T0 + 99);
      expect(backend.peekAvatarUrl(ref)).toBeUndefined();
      daemon.reply('getAvatar', { data: PNG });
      expect(await backend.resolveAvatarUrl(ref)).toBe(`data:image/png;base64,${PNG}`);
      await backend.disconnect();
    });

    it("keeps a contact's picture when a refresh finds nothing new about it", async () => {
      const { backend, daemon, scheduler } = await connected([self, bob]);
      const ref = { kind: 'contact', id: BOB } as const;
      await backend.resolveAvatarUrl(ref);
      scheduler.advance(DIRECTORY_TTL_MS + 1);
      await backend.listContacts();
      expect(backend.peekAvatarUrl(ref)).toBe(JPEG_URL);
      expect(daemon.callsTo('getAvatar')).toHaveLength(1);
      await backend.disconnect();
    });

    it("forgets a group's picture, and stamps a new version on it, when the group is updated", async () => {
      const { backend, daemon } = await connected([self]);
      const ref = { kind: 'group', id: GROUP } as const;
      await backend.resolveAvatarUrl(ref);
      const updates: Conversation[] = [];
      backend.on('conversationUpdated', (c) => updates.push(c));
      await backend.updateGroup(GROUP, { title: 'Renamed' });
      expect(updates.at(-1)?.avatarVersion).toBeGreaterThan(0);
      expect(backend.peekAvatarUrl(ref)).toBeUndefined();
      daemon.reply('getAvatar', { data: PNG });
      expect(await backend.resolveAvatarUrl(ref)).toBe(`data:image/png;base64,${PNG}`);
      await backend.disconnect();
    });

    it('shows a photo you just set on a group at once, and the stored one after', async () => {
      const { backend, daemon } = await connected([self]);
      const ref = { kind: 'group', id: GROUP } as const;
      const photo = 'data:image/png;base64,iVBORw0KGgoAAAA=';
      const calls = daemon.callsTo('getAvatar').length;
      await backend.updateGroup(GROUP, { avatar: photo });
      expect(backend.peekAvatarUrl(ref)).toBe(photo);
      expect(await backend.resolveAvatarUrl(ref)).toBe(photo);
      expect(daemon.callsTo('getAvatar')).toHaveLength(calls);
      await backend.disconnect();
    });

    it('shows a photo you just set on your profile at once, and its removal too', async () => {
      const { backend } = await connected([self]);
      const ref = { kind: 'contact', id: SELF_ACI } as const;
      const text = { givenName: 'Ada', familyName: '', about: '', aboutEmoji: '' };
      const added = await backend.updateProfile({
        ...text,
        avatar: { contentType: 'image/png', base64: 'iVBORw0KGgo=' },
      });
      expect(backend.peekAvatarUrl(ref)).toBe('data:image/png;base64,iVBORw0KGgo=');
      expect(added.avatarVersion).toBeGreaterThan(T0);
      const removed = await backend.updateProfile({ ...text, avatar: null });
      expect(backend.peekAvatarUrl(ref)).toBeNull();
      expect(removed.avatarVersion).toBeGreaterThan(added.avatarVersion ?? 0);
      await backend.disconnect();
    });
  });

  it('drops every picture on disconnect', async () => {
    const { backend } = await connected([self, bob]);
    const ref = { kind: 'contact', id: BOB } as const;
    await backend.resolveAvatarUrl(ref);
    await backend.disconnect();
    expect(backend.peekAvatarUrl(ref)).toBeUndefined();
  });
});
