// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { groupConversationId, type Conversation } from '@/core/domain';
import { ManualScheduler } from '@/core/lib';
import { createMemoryStorage } from '@/core/persistence';
import type { BackendEvents } from '../types';
import { describeGroupChange } from './normalise/directory';
import { toGroupConversation } from './normalise/directory';
import { groupChangeParams, newGroupParams } from './params';
import { SignalCliBackend } from './SignalCliBackend';
import { FakeDaemon, flush } from './testing';
import { decodeOrThrow } from './validate';
import { wireGroup } from './wire';
import {
  ALICE,
  ALICE_NUMBER,
  BOB,
  GROUP_ID,
  SELF_ACI,
  SELF_NUMBER,
  T0,
} from './fixtures/envelopes';

const GROUP = groupConversationId(GROUP_ID);
const AVATAR = 'data:image/jpeg;base64,AAAA';

const wireOf = (extra: object = {}) =>
  decodeOrThrow(wireGroup, {
    id: GROUP_ID,
    name: 'Club',
    members: [
      { uuid: SELF_ACI, number: SELF_NUMBER, isAdmin: true },
      { uuid: ALICE, number: ALICE_NUMBER, isAdmin: false, labelEmoji: '🧗', label: 'Belayer' },
    ],
    ...extra,
  });

describe('wireGroup: the rest of a group', () => {
  it('reads pending, requesting and banned members, the rules, the link and labels', () => {
    const conv = toGroupConversation(
      wireOf({
        pendingMembers: [{ uuid: BOB, number: null }],
        requestingMembers: [
          { uuid: 'zed', number: null },
          { uuid: 'abe', number: null },
        ],
        banned: [{ uuid: 'eve', number: null }],
        permissionAddMember: 'ONLY_ADMINS',
        permissionEditDetails: 'EVERY_MEMBER',
        permissionSendMessage: 'ONLY_ADMINS',
        groupInviteLink: 'https://signal.group/#x',
      }),
      (id) => id,
      0,
    );
    expect(conv.pendingMemberIds).toEqual([BOB]);
    expect(conv.requestingMemberIds).toEqual(['abe', 'zed']);
    expect(conv.bannedIds).toEqual(['eve']);
    expect(conv.permissions).toEqual({
      addMember: 'only-admins',
      editDetails: 'every-member',
      sendMessages: 'only-admins',
    });
    expect(conv.inviteLink).toBe('https://signal.group/#x');
    expect(conv.memberLabels).toEqual({ [ALICE]: { emoji: '🧗', label: 'Belayer' } });
  });

  it('leaves the fields out for an older daemon that reports none of them', () => {
    const conv = toGroupConversation(wireOf(), (id) => id, 0);
    for (const key of [
      'pendingMemberIds',
      'requestingMemberIds',
      'bannedIds',
      'permissions',
      'inviteLink',
    ])
      expect(conv).not.toHaveProperty(key);
  });
});

describe('groupChangeParams / newGroupParams', () => {
  it('sends only what is set, in signal-cli spelling', () => {
    expect(groupChangeParams('G', { title: ' New ' })).toEqual({ groupId: 'G', name: 'New' });
    expect(
      groupChangeParams('G', {
        description: 'd',
        avatar: AVATAR,
        addMemberIds: ['a'],
        removeMemberIds: ['b'],
        addAdminIds: ['c'],
        removeAdminIds: ['d'],
        link: 'approval',
        resetLink: true,
        permissions: {
          addMember: 'only-admins',
          editDetails: 'every-member',
          sendMessages: 'only-admins',
        },
      }),
    ).toEqual({
      groupId: 'G',
      description: 'd',
      avatar: 'data:image/jpeg;filename=avatar;base64,AAAA',
      member: ['a'],
      removeMember: ['b'],
      admin: ['c'],
      removeAdmin: ['d'],
      link: 'enabled-with-approval',
      resetLink: true,
      setPermissionAddMember: 'only-admins',
      setPermissionEditDetails: 'every-member',
      setPermissionSendMessages: 'only-admins',
    });
    expect(groupChangeParams('G', { link: 'on' }).link).toBe('enabled');
    expect(groupChangeParams('G', { link: 'off' }).link).toBe('disabled');
  });

  it('refuses a bad name, an over-long text and anything that is not an inline image', () => {
    expect(() => groupChangeParams('G', { title: '  ' })).toThrow();
    expect(() => groupChangeParams('G', { title: 'x'.repeat(33) })).toThrow();
    expect(() => groupChangeParams('G', { description: 'x'.repeat(481) })).toThrow();
    for (const avatar of [
      '/etc/passwd',
      'data:text/html;base64,AAAA',
      'file:///x',
      'data:image/png,AAAA',
    ])
      expect(() => groupChangeParams('G', { avatar })).toThrow();
  });

  it('makes a group without a groupId', () => {
    expect(newGroupParams({ title: 'T', memberIds: ['a', 'b'], avatar: AVATAR })).toEqual({
      name: 'T',
      member: ['a', 'b'],
      avatar: 'data:image/jpeg;filename=avatar;base64,AAAA',
    });
    expect(newGroupParams({ title: 'T', memberIds: [] })).toEqual({ name: 'T' });
    expect(() => newGroupParams({ title: '', memberIds: [] })).toThrow();
  });
});

describe('describeGroupChange: the group beyond its name', () => {
  const base: Conversation = {
    id: GROUP,
    kind: 'group',
    title: 'A',
    memberIds: ['me', 'al'],
    adminIds: ['me'],
    expireTimerSec: 0,
    lastActivityAt: 0,
    pendingMemberIds: [],
    requestingMemberIds: [],
    permissions: {
      addMember: 'every-member',
      editDetails: 'every-member',
      sendMessages: 'every-member',
    },
  };
  const nameOf = (id: string) => ({ me: 'You', al: 'Al', bo: 'Bo', cy: 'Cy' })[id] ?? id;
  const mine = (after: Partial<Conversation>) =>
    describeGroupChange(base, { ...base, ...after }, 'You', nameOf, true);

  it('says "You added", "You removed", "You invited", "You made … an admin"', () => {
    expect(mine({ memberIds: ['me', 'al', 'bo'] })).toEqual(['You added Bo.']);
    expect(mine({ memberIds: ['me'] })).toEqual(['You removed Al.']);
    expect(mine({ pendingMemberIds: ['cy'] })).toEqual(['You invited Cy to the group.']);
    expect(mine({ adminIds: ['me', 'al'] })).toEqual(['You made Al an admin.']);
  });

  it('describes approvals, denials, revoked invites and demotions', () => {
    const asking = { ...base, requestingMemberIds: ['bo', 'cy'], pendingMemberIds: ['cy'] };
    expect(
      describeGroupChange(
        asking,
        { ...asking, memberIds: ['me', 'al', 'bo'], requestingMemberIds: ['cy'] },
        'You',
        nameOf,
        true,
      ),
    ).toEqual(['You approved a request to join the group from Bo.']);
    expect(
      describeGroupChange(
        asking,
        { ...asking, requestingMemberIds: ['bo'], pendingMemberIds: [] },
        'You',
        nameOf,
        true,
      ),
    ).toEqual([
      'You revoked an invitation to the group for Cy.',
      'You denied a request to join the group from Cy.',
    ]);
    const admins = { ...base, adminIds: ['me', 'al'] };
    expect(
      describeGroupChange(admins, { ...admins, adminIds: ['me'] }, 'You', nameOf, true),
    ).toEqual(['You removed Al as an admin.']);
  });

  it('keeps someone else’s change neutral about added or joined', () => {
    expect(
      describeGroupChange(base, { ...base, memberIds: ['me', 'al', 'bo'] }, 'Al', nameOf),
    ).toEqual(['Bo joined the group.']);
    expect(describeGroupChange(base, { ...base, pendingMemberIds: ['cy'] }, 'Al', nameOf)).toEqual([
      'Al invited 1 person to the group.',
    ]);
  });

  it('describes rules and the link', () => {
    expect(
      mine({
        permissions: {
          addMember: 'only-admins',
          editDetails: 'only-admins',
          sendMessages: 'only-admins',
        },
      }),
    ).toEqual([
      'You changed who can edit group info to "Only admins."',
      'You changed who can edit group membership to "Only admins."',
      'You changed the group settings to only allow admins to send messages.',
    ]);
    expect(mine({ inviteLink: 'https://signal.group/#a' })).toEqual([
      'You turned on the group link.',
    ]);
    const on = { ...base, inviteLink: 'https://signal.group/#a' };
    expect(
      describeGroupChange(
        on,
        { ...on, inviteLink: 'https://signal.group/#b' },
        'You',
        nameOf,
        true,
      ),
    ).toEqual(['You reset the group link.']);
    expect(
      describeGroupChange(on, (({ inviteLink: _gone, ...rest }) => rest)(on), 'You', nameOf, true),
    ).toEqual(['You turned off the group link.']);
    expect(mine({ avatarUrl: AVATAR })).toEqual(['You changed the group avatar.']);
  });
});

function setup() {
  let current: object = wireOf({ permissionAddMember: 'EVERY_MEMBER' });
  const daemon = new FakeDaemon()
    .reply('listAccounts', [{ number: SELF_NUMBER, aci: SELF_ACI }])
    .handle('listContacts', () => ({ result: [] }))
    .handle('listGroups', (params) => ({
      result: params.groupId ? [current] : [current],
    }))
    .reply('updateGroup', { timestamp: T0 + 5, groupId: GROUP_ID })
    .reply('quitGroup', { timestamp: 1, results: [] });
  const scheduler = new ManualScheduler(T0 + 1000);
  const storage = createMemoryStorage();
  const backend = new SignalCliBackend({
    baseUrl: '/signal-cli',
    account: null,
    fetch: daemon.fetch,
    clock: scheduler,
    scheduler,
    random: () => 0,
    storage,
    onAccountSelected: () => undefined,
    debug: () => undefined,
  });
  const events: BackendEvents['message'][] = [];
  backend.on('message', (m) => events.push(m));
  return { daemon, backend, events, storage, relist: (next: object) => (current = next) };
}

describe('SignalCliBackend: groups', () => {
  it('updateGroup sends one call, re-lists, and writes the system line', async () => {
    const { daemon, backend, events, relist } = setup();
    await backend.connect();
    await flush();
    await backend.listConversations();
    relist(
      wireOf({
        members: [
          { uuid: SELF_ACI, number: SELF_NUMBER, isAdmin: true },
          { uuid: ALICE, number: ALICE_NUMBER, isAdmin: false },
          { uuid: BOB, number: null, isAdmin: false },
        ],
      }),
    );
    const updates: unknown[] = [];
    backend.on('conversationUpdated', (c) => updates.push(c));
    await backend.updateGroup(GROUP, { addMemberIds: [BOB] });
    expect(daemon.callsTo('updateGroup')).toEqual([
      { account: SELF_ACI, groupId: GROUP_ID, member: [BOB] },
    ]);
    expect(updates).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'system', conversationId: GROUP });
    expect(events.at(-1)?.systemText).toMatch(/^You added /u);
    await backend.disconnect();
  });

  it('createGroup omits groupId, announces the group and says "You created the group."', async () => {
    const { daemon, backend, events } = setup();
    await backend.connect();
    await flush();
    const made = await backend.createGroup({ title: 'Club', memberIds: [ALICE], avatar: AVATAR });
    expect(daemon.callsTo('updateGroup')[0]).toEqual({
      account: SELF_ACI,
      name: 'Club',
      member: [ALICE],
      avatar: 'data:image/jpeg;filename=avatar;base64,AAAA',
    });
    expect(made.id).toBe(GROUP);
    expect(made.avatarUrl).toBe(AVATAR);
    expect(events.at(-1)?.systemText).toBe('You created the group.');
    await backend.disconnect();
  });

  it('leaveGroup quits without deleting, keeps the chat as left and says "You left the group."', async () => {
    const { daemon, backend, events, relist, storage } = setup();
    await backend.connect();
    await flush();
    await backend.listConversations();
    // What signal-cli lists once we have quit: still there, no longer a member of it.
    relist(
      wireOf({
        isMember: false,
        members: [{ uuid: ALICE, number: ALICE_NUMBER, isAdmin: true }],
      }),
    );
    const updates: Conversation[] = [];
    backend.on('conversationUpdated', (c) => updates.push(c));
    await backend.leaveGroup(GROUP, [ALICE]);
    expect(daemon.callsTo('quitGroup')).toEqual([
      { account: SELF_ACI, groupId: GROUP_ID, admin: [ALICE] },
    ]);
    expect(updates.at(-1)).toMatchObject({ id: GROUP, left: true });
    expect(updates.at(-1)?.memberIds).not.toContain(SELF_ACI);
    expect(events.at(-1)?.systemText).toBe('You left the group.');
    // The chat survives a refresh of the group list, and a restart (it is remembered).
    expect((await backend.listConversations()).find((c) => c.id === GROUP)).toMatchObject({
      left: true,
    });
    expect([...storage.keys!()].some((k) => k.includes('left-groups'))).toBe(true);
    await backend.leaveGroup(GROUP);
    expect(daemon.callsTo('quitGroup')[1]).toEqual({ account: SELF_ACI, groupId: GROUP_ID });
    await backend.disconnect();
  });

  it('keeps a group that merely is not joined out of the list', async () => {
    const { backend, relist } = setup();
    relist(wireOf({ isMember: false }));
    await backend.connect();
    await flush();
    expect((await backend.listConversations()).find((c) => c.id === GROUP)).toBeUndefined();
    await backend.disconnect();
  });
});
