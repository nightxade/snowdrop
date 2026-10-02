import { describe, expect, it } from 'vitest';
import { makeConversation, makeMessage } from '@/core/domain/testing';
import { MemoryMessageRepository } from '@/core/persistence';
import { createStores } from '@/core/stores';
import { exportHistory, toExportedMessage } from './historyExport';

describe('history export (M8)', () => {
  it('leaves out disappearing messages and lists attachments without their contents', async () => {
    const stores = createStores();
    const conv = makeConversation();
    stores.conversations.getState().upsertMany([conv]);
    const repo = new MemoryMessageRepository();
    await repo.upsertMany(
      [
        makeMessage({
          conversationId: conv.id,
          sentAt: 1,
          body: 'kept',
          attachments: [
            {
              id: 'a',
              contentType: 'image/png',
              fileName: 'p.png',
              size: 9,
              url: 'data:image/png;base64,AAAA',
              width: 4,
            },
          ],
        }),
        makeMessage({ conversationId: conv.id, sentAt: 2, body: 'gone soon', expiresAt: 99 }),
      ],
      { backfill: true, merge: (a) => a },
    );
    const data = await exportHistory(repo, stores, new Date(0));
    const messages = data.conversations[0]?.messages ?? [];
    expect(messages.map((m) => m.body)).toEqual(['kept']);
    expect(messages[0]?.attachments).toEqual([
      { contentType: 'image/png', fileName: 'p.png', size: 9 },
    ]);
    expect(JSON.stringify(data)).not.toContain('base64');
  });

  it('toExportedMessage drops expiring messages', () => {
    expect(toExportedMessage(makeMessage({ expiresAt: 1 }))).toBeNull();
  });
});
