import { describe, expect, it } from 'vitest';
import { JsonRpcClient } from '../rpc';
import { FakeDaemon } from '../testing';
import { HistoryArchive } from './archive';
import { directConversationId, messageId } from '@/core/domain';

const self = '00000000-0000-0000-0000-000000000001';
const recipient = { cursor: '1', frame: { recipient: { id: '1', self: {} } } };
const chat = { cursor: '2', frame: { chat: { id: '3', recipientId: '1' } } };
const page = (entries: unknown[], nextCursor: string, hasMore = false, archiveId = 'snapshot') => ({
  archiveId,
  entries,
  nextCursor,
  hasMore,
});
function fixture() {
  const daemon = new FakeDaemon().reply('getHistoryDirectory', page([recipient, chat], '2'));
  const rpc = new JsonRpcClient({ baseUrl: '/signal-cli/', fetch: daemon.fetch });
  rpc.account = 'original-account';
  return { daemon, rpc, open: () => HistoryArchive.open(rpc, self) };
}

describe('phone history archive paging', () => {
  it('locates a cached message by identity across pages despite skewed sender clocks', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    const item = (cursor: string, sentAt: string) => ({
      cursor,
      frame: {
        chatItem: {
          chatId: '3',
          authorId: '1',
          dateSent: sentAt,
          incoming: { dateReceived: sentAt },
          standardMessage: { text: { body: cursor } },
        },
      },
    });
    daemon.handle('getHistoryChat', (params) => ({
      result:
        params.before === '4'
          ? page([item('3', '3000')], '3')
          : params.before === '5'
            ? page([item('3', '3000'), item('4', '1000')], '3')
            : page([item('5', '500')], '5', true),
    }));
    const older = await archive?.fetchHistory(
      directConversationId(self),
      { limit: 2, before: 1000, beforeId: messageId(self, 1000) },
      5000,
    );
    expect(older?.messages.map((message) => message.sentAt)).toEqual([3000]);
    expect(older?.hasMoreBefore).toBe(false);
    expect(daemon.callsTo('getHistoryChat').map((params) => params.before)).toEqual([
      undefined,
      '5',
      '4',
    ]);
  });

  it.each([false, true])(
    'falls back to a timestamp when no exact boundary exists (lookup: %s)',
    async (lookup) => {
      const { daemon, open } = fixture();
      const archive = await open();
      const item = (cursor: string, sentAt: string) => ({
        cursor,
        frame: {
          chatItem: {
            chatId: '3',
            authorId: '1',
            dateSent: sentAt,
            incoming: { dateReceived: sentAt },
            standardMessage: { text: { body: cursor } },
          },
        },
      });
      daemon.handle('getHistoryChat', (params) => ({
        result:
          params.before === '5'
            ? page([item('3', '1000'), item('4', '1500')], '3')
            : page([item('5', '2000'), item('6', '3000')], '5', true),
      }));
      const older = await archive?.fetchHistory(
        directConversationId(self),
        { limit: 2, before: 2000, ...(lookup ? { beforeId: messageId(self, 1999) } : {}) },
        5000,
      );
      expect(older?.messages.map((message) => message.sentAt)).toEqual([1000, 1500]);
      expect(older?.hasMoreBefore).toBe(false);
      expect(daemon.callsTo('getHistoryChat').map((params) => params.before)).toEqual(
        lookup ? [undefined, '5', undefined, '5'] : [undefined, '5'],
      );
    },
  );

  it('pages converted messages by persisted cursor instead of their skewed timestamps', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    const item = (cursor: string, sentAt: string) => ({
      cursor,
      frame: {
        chatItem: {
          chatId: '3',
          authorId: '1',
          dateSent: sentAt,
          incoming: { dateReceived: sentAt },
          standardMessage: { text: { body: cursor } },
        },
      },
    });
    daemon.reply(
      'getHistoryChat',
      page([item('3', '2000'), item('4', '1000'), item('5', '1001')], '3'),
    );
    const newest = await archive?.fetchHistory(directConversationId(self), { limit: 2 }, 5000);
    expect(newest?.messages.map((message) => message.historyCursor)).toEqual([
      'snapshot:4',
      'snapshot:5',
    ]);
    expect(newest?.hasMoreBefore).toBe(true);
    daemon.reply('getHistoryChat', page([item('3', '2000')], '3'));
    const older = await archive?.fetchHistory(
      directConversationId(self),
      { limit: 2, before: 1000, beforeCursor: 'snapshot:4' },
      5000,
    );
    expect(older?.messages.map((message) => message.sentAt)).toEqual([2000]);
    expect(daemon.calls.at(-1)?.params.before).toBe('4');
    await expect(
      archive?.fetchHistory(
        directConversationId(self),
        { limit: 2, beforeCursor: 'replacement:4' },
        5000,
      ),
    ).rejects.toThrow('changed');
  });

  it('starts expiration only through an explicit read and validates every returned cursor', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    expect(daemon.callsTo('readHistory')).toEqual([]);
    daemon.reply('readHistory', [{ cursor: '3', expiresAt: '5000', unavailable: false }]);
    expect(await archive?.read(['3'])).toEqual([
      { cursor: '3', expiresAt: '5000', unavailable: false },
    ]);
    expect(daemon.callsTo('readHistory')[0]).toEqual({
      account: 'original-account',
      archiveId: 'snapshot',
      cursors: ['3'],
    });
    daemon.reply('getHistoryReadState', [{ cursor: '3', expiresAt: '5000', unavailable: false }]);
    await archive?.read(['3'], false);
    expect(daemon.callsTo('getHistoryReadState')).toHaveLength(1);
    expect(daemon.callsTo('readHistory')).toHaveLength(1);
    daemon.reply('readHistory', [{ cursor: '4', expiresAt: '5000', unavailable: false }]);
    await expect(archive?.read(['3'])).rejects.toThrow('unrequested');
    daemon.reply('readHistory', []);
    await expect(archive?.read(['3'])).rejects.toThrow('omitted');
  });

  it('loads the complete directory and pins requests to its account and snapshot', async () => {
    const { daemon, rpc, open } = fixture();
    daemon.handle('getHistoryDirectory', (params) => ({
      result: params.after === '1' ? page([chat], '2') : page([recipient], '1', true),
    }));
    const archive = await open();
    expect(archive?.directory.conversations()).toHaveLength(1);
    rpc.account = 'different-account';
    daemon.reply('getHistoryChat', page([], '0'));
    await archive?.chatPage('3', undefined, 50);
    expect(daemon.calls.at(-1)?.params).toEqual({
      account: 'original-account',
      archiveId: 'snapshot',
      chatId: '3',
      limit: 50,
    });
    expect(daemon.calls[1]?.params).toMatchObject({ archiveId: 'snapshot', after: '1' });
  });

  it('uses exact ordinal cursors regardless of sender clocks', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    const entry = (cursor: string, dateSent: string) => ({
      cursor,
      frame: { chatItem: { chatId: '3', dateSent } },
    });
    daemon.reply(
      'getHistoryChat',
      page(
        [entry('9007199254740993', '2000'), entry('9007199254740994', '1000')],
        '9007199254740993',
        true,
      ),
    );
    const newest = await archive?.chatPage('3', undefined, 2);
    expect(newest?.entries.map((entry) => entry.cursor)).toEqual([
      '9007199254740993',
      '9007199254740994',
    ]);
    daemon.reply('getHistoryChat', page([entry('4', '2000')], '4'));
    await archive?.chatPage('3', newest?.nextCursor, 2);
    expect(daemon.calls.at(-1)?.params.before).toBe('9007199254740993');
  });

  it('treats stock signal-cli or an absent archive as no imported history', async () => {
    const { daemon, open } = fixture();
    daemon.handle('getHistoryDirectory', () => ({
      error: { code: -32601, message: 'Method not found' },
    }));
    expect(await open()).toBeNull();
    daemon.reply('getHistoryDirectory', { entries: [], hasMore: false, nextCursor: '0' });
    expect(await open()).toBeNull();
  });

  it('does not disguise permission, IO, or malformed responses as an empty history', async () => {
    const { daemon, open } = fixture();
    daemon.handle('getHistoryDirectory', () => ({
      error: { code: -3, message: 'database unavailable' },
    }));
    await expect(open()).rejects.toThrow('database unavailable');
    daemon.reply('getHistoryDirectory', page([{ frame: recipient.frame }], '1'));
    await expect(open()).rejects.toThrow();
  });

  it('rejects a stalled directory cursor and a changed archive', async () => {
    const { daemon, open } = fixture();
    daemon.reply('getHistoryDirectory', page([recipient], '1', true));
    await expect(open()).rejects.toThrow('cursor');
    daemon.handle('getHistoryDirectory', (params) => ({
      result: params.after ? page([chat], '2', false, 'replacement') : page([recipient], '1', true),
    }));
    await expect(open()).rejects.toThrow('changed');
  });

  it("answers chatLatestMessageAt with the newest real message's own dateSent, skipping a newer system entry", async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    daemon.reply(
      'getHistoryChat',
      page(
        [
          {
            cursor: '3',
            frame: {
              chatItem: { chatId: '3', dateSent: '500', standardMessage: { text: { body: 'hi' } } },
            },
          },
          {
            cursor: '4',
            frame: {
              chatItem: {
                chatId: '3',
                dateSent: '900',
                updateMessage: { simpleUpdate: { type: 'JOINED_SIGNAL' } },
              },
            },
          },
        ],
        '3',
      ),
    );
    await expect(archive?.chatLatestMessageAt('3')).resolves.toBe(500);
    // Cached for the archive's lifetime: a second call makes no further request.
    const before = daemon.callsTo('getHistoryChat').length;
    await archive?.chatLatestMessageAt('3');
    expect(daemon.callsTo('getHistoryChat')).toHaveLength(before);
  });

  it('answers chatLatestMessageAt with undefined for a chat with only system entries, across pages', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    const system = (cursor: string) => ({
      cursor,
      frame: {
        chatItem: {
          chatId: '3',
          dateSent: cursor,
          updateMessage: { simpleUpdate: { type: 'JOINED_SIGNAL' } },
        },
      },
    });
    daemon.handle('getHistoryChat', (params) => ({
      result:
        params.before === '5'
          ? page([system('3'), system('4')], '3')
          : page([system('5'), system('6')], '5', true),
    }));
    await expect(archive?.chatLatestMessageAt('3')).resolves.toBeUndefined();
  });

  it('rejects chat pages from a different chat, snapshot, or cursor range', async () => {
    const { daemon, open } = fixture();
    const archive = await open();
    for (const result of [
      page([{ cursor: '4', frame: { chatItem: { chatId: '9' } } }], '4'),
      page([{ cursor: '4', frame: { chatItem: { chatId: '3' } } }], '4', false, 'replacement'),
      page([{ cursor: '10', frame: { chatItem: { chatId: '3' } } }], '10'),
      page([], '4', true),
    ]) {
      daemon.reply('getHistoryChat', result);
      await expect(archive?.chatPage('3', '10', 50)).rejects.toThrow();
    }
  });
});
