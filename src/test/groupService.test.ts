import { afterEach, describe, expect, it } from 'vitest';
import { createSnowdrop, type Snowdrop } from '@/app';
import type { MockBackend } from '@/core/backend/mock';
import { createMemoryStorage } from '@/core/persistence';
import { canManageGroup, type Conversation } from '@/core/domain';

const live: Snowdrop[] = [];
afterEach(async () => {
  for (const s of live.splice(0)) await s.dispose();
});

async function boot() {
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(snowdrop);
  snowdrop.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await snowdrop.start();
  await snowdrop.sync.idle();
  const mock = (await snowdrop.backendReady) as MockBackend;
  const selfId = snowdrop.stores.session.getState().self!.id;
  const groups = Object.values(snowdrop.stores.conversations.getState().byId).filter(
    (c) => c.kind === 'group',
  );
  const admin = groups.find((c) => c.adminIds.includes(selfId) && c.requestingMemberIds?.length)!;
  const member = groups.find(
    (c) => !c.adminIds.includes(selfId) && c.permissions?.editDetails === 'only-admins',
  )!;
  const announcement = groups.find((c) => c.permissions?.sendMessages === 'only-admins')!;
  const other = (c: Conversation) => c.memberIds.find((m) => m !== selfId)!;
  return { snowdrop, mock, selfId, admin, member, announcement, other };
}
const stored = (s: Snowdrop, c: Conversation) => s.stores.conversations.getState().byId[c.id]!;

describe('GroupService: permission gating', () => {
  it('refuses, without asking the backend, what our role cannot do', async () => {
    const { snowdrop, mock, member, other } = await boot();
    const calls: unknown[] = [];
    const original = mock.updateGroup.bind(mock);
    mock.updateGroup = (id, change) => {
      calls.push(change);
      return original(id, change);
    };
    expect(snowdrop.groups.allows(member.id, { title: 'X' })).toBe(false);
    expect(snowdrop.groups.allows(member.id, { addMemberIds: ['x'] })).toBe(false);
    expect(snowdrop.groups.allows(member.id, { removeMemberIds: [other(member)] })).toBe(false);
    expect(snowdrop.groups.allows(member.id, { link: 'on' })).toBe(false);
    expect(await snowdrop.groups.update(member.id, { title: 'X' })).toMatch(
      /can't make that change/u,
    );
    expect(calls).toEqual([]);
  });

  it('lets an admin do all of it, and treats approving a request as admin-only', async () => {
    const { snowdrop, admin } = await boot();
    const asking = admin.requestingMemberIds![0]!;
    expect(
      snowdrop.groups.allows(admin.id, { title: 'X', link: 'on', addMemberIds: [asking] }),
    ).toBe(true);
  });

  it('rejects an empty or over-long name before sending', async () => {
    const { snowdrop, admin } = await boot();
    expect(await snowdrop.groups.update(admin.id, { title: '  ' })).toMatch(/needs a name/u);
    expect(await snowdrop.groups.update(admin.id, { title: 'x'.repeat(33) })).toMatch(/too long/u);
    expect(await snowdrop.groups.update(admin.id, { description: 'x'.repeat(481) })).toMatch(
      /too long/u,
    );
  });
});

describe('GroupService: actions and system lines', () => {
  it('edits details and writes "You changed…" lines', async () => {
    const { snowdrop, admin } = await boot();
    expect(
      await snowdrop.groups.update(admin.id, { title: 'Renamed', description: 'About us' }),
    ).toBeNull();
    await snowdrop.sync.idle();
    expect(stored(snowdrop, admin).title).toBe('Renamed');
    expect(stored(snowdrop, admin).description).toBe('About us');
    const latest = await snowdrop.repository.latest(admin.id);
    expect(latest?.systemText).toBe(
      'You changed the group name to "Renamed". You changed the group description.',
    );
  });

  it('removes and promotes members, approves and denies requests, revokes invites', async () => {
    const { snowdrop, admin, other, selfId } = await boot();
    const [a, b] = admin.requestingMemberIds!;
    const invited = admin.pendingMemberIds![0]!;
    const target = other(admin);
    expect(await snowdrop.groups.update(admin.id, { addMemberIds: [a!] })).toBeNull();
    expect(await snowdrop.groups.update(admin.id, { removeMemberIds: [b!] })).toBeNull();
    expect(await snowdrop.groups.update(admin.id, { removeMemberIds: [invited] })).toBeNull();
    expect(await snowdrop.groups.update(admin.id, { addAdminIds: [target] })).toBeNull();
    await snowdrop.sync.idle();
    const now = stored(snowdrop, admin);
    expect(now.memberIds).toContain(a);
    expect(now.requestingMemberIds).toEqual([]);
    expect(now.pendingMemberIds).toEqual([]);
    expect(now.adminIds).toContain(target);
    expect(await snowdrop.groups.update(admin.id, { removeMemberIds: [target] })).toBeNull();
    await snowdrop.sync.idle();
    expect(stored(snowdrop, admin).memberIds).not.toContain(target);
    expect(canManageGroup(stored(snowdrop, admin), selfId)).toBe(true);
    const text = (await snowdrop.repository.latest(admin.id))?.systemText;
    expect(text).toMatch(/^You removed /u);
  });

  it('turns the link on and off, resets it, and changes the rules', async () => {
    const { snowdrop, admin } = await boot();
    const first = stored(snowdrop, admin).inviteLink!;
    expect(await snowdrop.groups.update(admin.id, { resetLink: true })).toBeNull();
    const second = stored(snowdrop, admin).inviteLink!;
    expect(second).not.toBe(first);
    expect(await snowdrop.groups.update(admin.id, { link: 'off' })).toBeNull();
    expect(stored(snowdrop, admin).inviteLink).toBeUndefined();
    expect(await snowdrop.groups.update(admin.id, { link: 'approval' })).toBeNull();
    expect(stored(snowdrop, admin).inviteLink).toBeDefined();
    expect(
      await snowdrop.groups.update(admin.id, { permissions: { sendMessages: 'only-admins' } }),
    ).toBeNull();
    expect(stored(snowdrop, admin).permissions?.sendMessages).toBe('only-admins');
    await snowdrop.sync.idle();
    expect((await snowdrop.repository.latest(admin.id))?.systemText).toContain('only allow admins');
  });

  it('says why when the backend refuses, and changes nothing', async () => {
    const { snowdrop, mock, admin } = await boot();
    mock.failNext();
    expect(await snowdrop.groups.update(admin.id, { title: 'Nope' })).toMatch(
      /Check your connection/u,
    );
    expect(stored(snowdrop, admin).title).not.toBe('Nope');
  });
});

describe('GroupService: create and leave', () => {
  it('creates a group with us as admin, accepted, with a first line', async () => {
    const { snowdrop, selfId, other, admin } = await boot();
    const result = await snowdrop.groups.create({
      title: ' Weekend crew ',
      memberIds: [other(admin)],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    await snowdrop.sync.idle();
    const made = snowdrop.stores.conversations.getState().byId[result.id]!;
    expect(made).toMatchObject({ kind: 'group', title: 'Weekend crew', adminIds: [selfId] });
    expect(made.memberIds).toEqual([selfId, other(admin)]);
    expect((await snowdrop.repository.latest(result.id))?.systemText).toBe(
      'You created the group.',
    );
    expect(await snowdrop.groups.create({ title: '', memberIds: [] })).toMatchObject({ ok: false });
  });

  it('makes the last admin choose a successor before leaving, then keeps the chat read-only', async () => {
    const { snowdrop, mock, admin, selfId, other } = await boot();
    const result = await snowdrop.groups.create({ title: 'Mine', memberIds: [other(admin)] });
    if (!result.ok) throw new Error('create failed');
    expect(await snowdrop.groups.leave(result.id)).toMatch(/at least one new admin/u);
    expect(await snowdrop.groups.leave(result.id, [selfId])).toMatch(/at least one new admin/u);
    expect(stored(snowdrop, { id: result.id } as Conversation).left).toBeUndefined();
    expect(await snowdrop.groups.leave(result.id, [other(admin)])).toBeNull();
    await snowdrop.sync.idle();
    const left = snowdrop.stores.conversations.getState().byId[result.id]!;
    expect(left.left).toBe(true);
    expect(left.memberIds).toEqual([other(admin)]);
    expect(left.adminIds).toEqual([other(admin)]);
    expect(mock.world.conversations.get(result.id)?.left).toBe(true);
    // History stays, with our line at the end.
    expect((await snowdrop.repository.latest(result.id))?.systemText).toBe('You left the group.');
    expect(
      await snowdrop.repository.get((await snowdrop.repository.latest(result.id))!.id),
    ).toBeDefined();
    // Nothing more can be done in it, and leaving twice is refused.
    expect(snowdrop.groups.allows(result.id, { title: 'X' })).toBe(false);
    expect(await snowdrop.groups.leave(result.id)).toMatch(/can't make that change/u);
  });

  it('lets anyone else leave straight away, and the chat stays', async () => {
    const { snowdrop, member } = await boot();
    expect(await snowdrop.groups.leave(member.id)).toBeNull();
    await snowdrop.sync.idle();
    expect(snowdrop.stores.conversations.getState().byId[member.id]?.left).toBe(true);
    expect((await snowdrop.repository.latest(member.id))?.systemText).toBe('You left the group.');
  });
});

describe('announcement groups', () => {
  it('refuses a send from a non-admin at the backend', async () => {
    const { snowdrop, announcement, selfId } = await boot();
    expect(announcement.adminIds).not.toContain(selfId);
    expect(announcement.permissions?.sendMessages).toBe('only-admins');
    expect(snowdrop.groups.available).toBe(true);
  });
});
