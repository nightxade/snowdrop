import { describe, expect, it } from 'vitest';
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
});
