import { describe, expect, it } from 'vitest';
import { BackupDirectory } from './directory';
import { backupMessage } from './messages';

const SELF = '00000000-0000-0000-0000-000000000001';
const PEER = '00000000-0000-0000-0000-000000000002';
function directory() {
  const d = new BackupDirectory(SELF);
  d.add({ recipient: { id: '1', self: {} } });
  d.add({
    recipient: { id: '2', contact: { aci: 'AAAAAAAAAAAAAAAAAAAAAg==', profileGivenName: 'Ada' } },
  });
  d.add({ chat: { id: '3', recipientId: '2' } });
  return d;
}
const base = {
  chatId: '3',
  authorId: '2',
  dateSent: '1000',
  incoming: { dateReceived: '1200', read: true },
};
const convert = (item: Record<string, unknown>) =>
  backupMessage({ archiveId: 'snapshot', cursor: '10', item, directory: directory(), now: 5000 });

describe('phone-history messages', () => {
  it('retains a downloadable full-text file when a message has a long-text attachment', () => {
    const message = convert({
      ...base,
      standardMessage: {
        text: { body: 'Preview' },
        longText: { contentType: 'text/plain', locatorInfo: { size: 9000, key: 'secret' } },
      },
    });
    expect(message?.body).toBe('Preview');
    expect(message?.attachments[0]).toMatchObject({
      id: 'history:snapshot:10:longText:0',
      fileName: 'message.txt',
      size: 9000,
    });
    expect(JSON.stringify(message)).not.toContain('secret');
  });
  it('keeps shared contact details, poll choices, and story reply text', () => {
    expect(
      convert({
        ...base,
        contactMessage: {
          contact: {
            name: { givenName: 'Ada', familyName: 'Lovelace' },
            number: [{ value: '+1234' }],
            email: [{ value: 'ada@example.test' }],
          },
        },
      })?.body,
    ).toBe('Shared a contact: Ada Lovelace\n+1234\nada@example.test');
    const poll = convert({
      ...base,
      poll: {
        question: 'When?',
        options: [{ option: 'Today' }, { option: 'Tomorrow' }],
        hasEnded: true,
      },
    });
    expect(poll?.body).toContain('Poll: When?\n• Today\n• Tomorrow\nPoll closed.');
    expect(
      convert({
        ...base,
        directStoryReplyMessage: {
          textReply: { text: { body: 'Nice photo', bodyRanges: [{ length: 4, style: 'BOLD' }] } },
        },
      }),
    ).toMatchObject({ body: 'Nice photo', ranges: [{ start: 0, length: 4, style: 'bold' }] });
  });

  it('imports sticker media without its pack encryption key', () => {
    const sticker = convert({
      ...base,
      stickerMessage: {
        sticker: {
          emoji: '🌸',
          packKey: 'secret-key',
          data: { contentType: 'image/webp', locatorInfo: { size: 12 } },
        },
      },
    });
    expect(sticker?.attachments[0]).toMatchObject({
      id: 'history:snapshot:10:sticker:0',
      contentType: 'image/webp',
      size: 12,
    });
    expect(JSON.stringify(sticker)).not.toContain('secret-key');
  });

  it('retains known chat updates as system rows and skips unknown update variants', () => {
    expect(
      convert({ ...base, updateMessage: { expirationTimerChange: { expiresInMs: '0' } } }),
    ).toMatchObject({ kind: 'system', systemText: 'Disappearing messages were turned off.' });
    expect(
      convert({
        ...base,
        updateMessage: { individualCall: { type: 'VIDEO_CALL', state: 'MISSED' } },
      })?.systemText,
    ).toBe('Missed video call.');
    expect(convert({ ...base, updateMessage: { futureUpdate: {} } })).toBeNull();
  });

  it('preserves active timers and leaves unstarted timers pending until read', () => {
    expect(
      convert({ ...base, expireStartDate: '4000', expiresInMs: '2000', standardMessage: {} }),
    ).toMatchObject({ expiresAt: 6000 });
    const pending = convert({ ...base, expiresInMs: '2000', standardMessage: {} });
    expect(pending).toMatchObject({ expiresAfterReadMs: 2000, historyCursor: 'snapshot:10' });
    expect(pending).not.toHaveProperty('expiresAt');
  });

  it('skips missing directional details and ignores invalid formatting spans', () => {
    expect(
      convert({ chatId: '3', authorId: '2', dateSent: '1000', standardMessage: {} }),
    ).toBeNull();
    const result = convert({
      ...base,
      standardMessage: {
        text: {
          body: 'hello',
          bodyRanges: [
            { length: 2, style: 'ITALIC' },
            { start: 4, length: 2, style: 'BOLD' },
            { start: -1, length: 1, style: 'BOLD' },
            { start: 0, length: 1, style: 'NONE' },
          ],
        },
      },
    });
    expect(result?.ranges).toEqual([{ start: 0, length: 2, style: 'italic' }]);
  });

  it('retains pending status without creating an outgoing send', () => {
    const result = convert({
      chatId: '3',
      authorId: '1',
      dateSent: '1000',
      outgoing: { sendStatus: [{ pending: {} }] },
      standardMessage: { text: { body: 'unsent' } },
    });
    expect(result).toMatchObject({ status: 'pending', body: 'unsent' });
    expect(result).not.toHaveProperty('nonce');
  });

  it('preserves original message identity after edits, with current text and formatting', () => {
    const result = convert({
      ...base,
      dateSent: '2000',
      revisions: [base],
      standardMessage: {
        text: { body: 'edited', bodyRanges: [{ start: 0, length: 6, style: 'BOLD' }] },
        reactions: [{ authorId: '1', emoji: '👍', sentTimestamp: '3000' }],
      },
    });
    expect(result).toMatchObject({
      id: `${PEER}:1000`,
      sentAt: 1000,
      receivedAt: 1200,
      body: 'edited',
      edits: 1,
      editedAt: 2000,
      ranges: [{ start: 0, length: 6, style: 'bold' }],
      reactions: [{ authorId: SELF, emoji: '👍', at: 3000 }],
    });
  });
  it('maps quote authors and attachment metadata without exposing locator keys', () => {
    const result = convert({
      ...base,
      standardMessage: {
        quote: { authorId: '1', targetSentTimestamp: '500', text: { body: 'quoted' } },
        attachments: [
          {
            pointer: {
              contentType: 'image/png',
              fileName: 'photo.png',
              width: 20,
              height: 10,
              locatorInfo: { size: 8, key: 'secret', transitCdnKey: 'cdn-key' },
            },
          },
        ],
      },
    });
    expect(result?.quote).toMatchObject({ authorId: SELF, sentAt: 500, text: 'quoted' });
    expect(result?.attachments[0]).toEqual({
      id: 'history:snapshot:10:attachment:0',
      contentType: 'image/png',
      fileName: 'photo.png',
      size: 8,
      width: 20,
      height: 10,
    });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('does not revive expired, deleted or view-once content', () => {
    expect(
      convert({
        ...base,
        expireStartDate: '1000',
        expiresInMs: '1000',
        standardMessage: { text: { body: 'expired' } },
      }),
    ).toBeNull();
    expect(
      convert({
        ...base,
        remoteDeletedMessage: {},
        revisions: [{ ...base, standardMessage: { text: { body: 'secret' } } }],
      }),
    ).toMatchObject({ deleted: true, body: '', attachments: [] });
    const once = convert({
      ...base,
      viewOnceMessage: { attachment: { pointer: { fileName: 'secret.png' } } },
    });
    expect(once?.attachments).toEqual([]);
    expect(once?.body).toContain('View-once');
    expect(JSON.stringify(once)).not.toContain('secret.png');
  });
  it('skips unknown future content and malformed references instead of inventing identities', () => {
    expect(convert({ ...base, futureMessage: {} })).toBeNull();
    expect(
      convert({ ...base, authorId: '999', standardMessage: { text: { body: 'unknown' } } }),
    ).toBeNull();
  });
});
