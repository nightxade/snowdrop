import { describe, expect, it, vi } from 'vitest';
import { BackupDirectory, backupUuid } from './directory';

const SELF = '00000000-0000-0000-0000-000000000001';
const PEER = '00000000-0000-0000-0000-000000000002';
const ACI = 'AAAAAAAAAAAAAAAAAAAAAg==';

describe('phone-history directory', () => {
  it('maps archive-local IDs to self and contact identities without rounding', () => {
    const directory = new BackupDirectory(SELF);
    directory.add({ recipient: { id: '1', self: {} } });
    directory.add({
      recipient: {
        id: '18446744073709551615',
        contact: {
          aci: ACI,
          e164: '15551234567',
          profileGivenName: 'Ada',
          nickname: { given: 'A' },
        },
      },
    });
    directory.add({
      chat: {
        id: '9007199254740993',
        recipientId: '18446744073709551615',
        expirationTimerMs: '60000',
      },
    });
    expect(directory.author('1')).toBe(SELF);
    expect(directory.author('18446744073709551615')).toBe(PEER);
    expect(directory.contacts()[0]).toMatchObject({ id: PEER, name: 'A', number: '+15551234567' });
    expect(directory.conversations()[0]).toMatchObject({
      id: `dm:${PEER}`,
      title: 'A',
      expireTimerSec: 60,
    });
    expect(directory.chatId(`dm:${PEER}`)).toBe('9007199254740993');
  });

  it('uses derived Signal group IDs and snapshot membership', () => {
    const directory = new BackupDirectory(SELF);
    directory.add({
      recipient: {
        id: '2',
        group: {
          snapshot: {
            title: { title: 'Study group' },
            description: { descriptionText: 'Research' },
            members: [{ userId: ACI, role: 'ADMINISTRATOR' }],
          },
        },
      },
      signalGroupId: 'canonical-group-id',
    });
    directory.add({ chat: { id: '3', recipientId: '2' } });
    expect(directory.conversations()[0]).toMatchObject({
      id: 'group:canonical-group-id',
      title: 'Study group',
      description: 'Research',
      memberIds: [PEER],
      adminIds: [PEER],
    });
  });

  it('reads who is saved, sharing a profile or blocked, and a blocked group, for message requests', () => {
    const directory = new BackupDirectory(SELF);
    directory.add({
      recipient: {
        id: '4',
        contact: { aci: ACI, profileGivenName: 'Ada', profileSharing: true, blocked: true },
      },
    });
    expect(directory.contacts()[0]).toMatchObject({ profileSharing: true, blocked: true });
    expect(directory.contacts()[0]).not.toHaveProperty('inContacts');
    const saved = new BackupDirectory(SELF);
    saved.add({
      recipient: { id: '5', contact: { aci: ACI, systemGivenName: 'Ada', systemFamilyName: 'L' } },
    });
    expect(saved.contacts()[0]).toMatchObject({ inContacts: true, name: 'Ada L' });
    const groups = new BackupDirectory(SELF);
    groups.add({
      recipient: { id: '6', group: { blocked: true, snapshot: { title: { title: 'G' } } } },
      signalGroupId: 'g1',
    });
    groups.add({ chat: { id: '7', recipientId: '6' } });
    expect(groups.conversations()[0]).toMatchObject({ id: 'group:g1', blocked: true });
  });

  it('does not manufacture chat identities for unsupported destinations', () => {
    const directory = new BackupDirectory(SELF);
    directory.add({ recipient: { id: '2', distributionList: {} } });
    directory.add({ chat: { id: '3', recipientId: '2' } });
    expect(directory.conversations()).toEqual([]);
  });

  it('rejects invalid UUID bytes and unsafe numeric archive IDs', () => {
    expect(backupUuid('not base64')).toBeUndefined();
    expect(backupUuid('AA==')).toBeUndefined();
    expect(backupUuid(ACI)).toBe(PEER);
    const directory = new BackupDirectory(SELF);
    expect(() => {
      directory.add({ recipient: { id: 9007199254740992, self: {} } });
    }).toThrow();
  });

  it('finds a chat from its conversation without rebuilding every conversation per lookup', () => {
    const directory = new BackupDirectory(SELF);
    const count = 40;
    for (let i = 1; i <= count; i += 1) {
      directory.add({
        recipient: {
          id: String(i),
          contact: {
            aci: Buffer.from(`${'0'.repeat(30)}${(i + 16).toString(16)}`, 'hex').toString('base64'),
          },
        },
      });
      directory.add({ chat: { id: String(100 + i), recipientId: String(i) } });
    }
    const spy = vi.spyOn(directory, 'conversation');
    const ids = directory.conversations().map((conversation) => conversation.id);
    expect(ids).toHaveLength(count);
    spy.mockClear();
    const found = ids.map((id) => directory.chatId(id));
    expect(found).toEqual(ids.map((_, i) => String(101 + i)));
    expect(spy.mock.calls.length).toBeLessThanOrEqual(count);
    expect(directory.chatId('dm:unknown')).toBeUndefined();
    // A later frame is visible.
    directory.add({ recipient: { id: '900', self: {} } });
    directory.add({ chat: { id: '901', recipientId: '900' } });
    expect(directory.chatId(`dm:${SELF}`)).toBe('901');
  });
});
