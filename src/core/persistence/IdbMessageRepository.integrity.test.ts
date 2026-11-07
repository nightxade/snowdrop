/**
 * A stored row that can't be read (corrupted, or sealed under a different
 * key) must never block writes to its id nor break restoring the outbox. The
 * rows are damaged through the raw database, below the repository.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeDuplicate, mergeOutgoingCommit, messageId, pendingMessageId } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
let dbCounter = 0;
const conv = conversationIdFor('integrity');

describe('IdbMessageRepository: unreadable rows', () => {
  let repo: IdbMessageRepository | undefined;
  afterEach(() => {
    repo?.close();
    repo = undefined;
  });

  async function setup() {
    const name = `snowdrop-integrity-${++dbCounter}`;
    repo = await IdbMessageRepository.open(name, await webCryptoCipher(randomKey()));
    const rows = async <T>(store: string, fn: (all: unknown[]) => Promise<T> | T): Promise<T> => {
      const raw = await openDB(name);
      try {
        return await fn(await raw.getAll(store));
      } finally {
        raw.close();
      }
    };
    /** Overwrites every row's payload in `store` that `match` accepts with bytes no key can open. */
    const corrupt = async (store: string, match: (row: Record<string, unknown>) => boolean) => {
      const raw = await openDB(name);
      for (const row of (await raw.getAll(store)) as Record<string, unknown>[]) {
        if (match(row)) await raw.put(store, { ...row, payload: new Uint8Array(48).fill(7) });
      }
      raw.close();
    };
    return { repo, rows, corrupt };
  }

  it('an unreadable existing row is replaced by upsert', async () => {
    const { repo, corrupt } = await setup();
    const m = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 1, body: 'old' });
    await repo.upsert(m, mergeDuplicate);
    await corrupt('messages', () => true);

    const result = await repo.upsert({ ...m, body: 'new' }, mergeDuplicate);
    expect(result.created).toBe(true);
    expect((await repo.get(m.id))?.body).toBe('new');
  });

  it('an unreadable row does not break upsertMany, commitOutgoing or update', async () => {
    const { repo, corrupt } = await setup();
    const m = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 2, body: 'old' });
    const final = makeMessage({
      conversationId: conv,
      authorId: 'me',
      sentAt: 3,
      body: 'sent',
      nonce: 'n1',
    });
    await repo.upsertMany([m, final], { backfill: false, merge: mergeDuplicate });
    await corrupt('messages', () => true);

    // update treats the row as absent (nothing to update) rather than throwing.
    await expect(repo.update(m.id, (x) => ({ ...x, body: 'edited' }))).resolves.toBeUndefined();

    await repo.upsertMany([{ ...m, body: 'again' }], { backfill: false, merge: mergeDuplicate });
    expect((await repo.get(m.id))?.body).toBe('again');

    await corrupt('messages', () => true);
    await repo.stageOutgoing(
      makeMessage({ id: pendingMessageId('n1'), conversationId: conv, nonce: 'n1' }),
      { nonce: 'n1', input: { conversationId: conv, body: 'sent', ranges: [] }, createdAt: 1 },
    );
    const committed = await repo.commitOutgoing('n1', final, mergeOutgoingCommit);
    expect(committed.message.id).toBe(messageId('me', 3));
    expect((await repo.get(final.id))?.body).toBe('sent');
  });

  it('delete still removes an unreadable row', async () => {
    const { repo, corrupt, rows } = await setup();
    const m = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 4 });
    await repo.upsert(m, mergeDuplicate);
    await corrupt('messages', () => true);
    await repo.delete(m.id);
    expect(await rows('messages', (all) => all.length)).toBe(0);
  });

  it('an unreadable outbox entry is skipped and kept; the rest are restored', async () => {
    const { repo, corrupt, rows } = await setup();
    const input = (body: string) => ({ conversationId: conv, body, ranges: [] });
    for (const [i, nonce] of ['bad', 'good'].entries()) {
      await repo.stageOutgoing(
        makeMessage({ id: pendingMessageId(nonce), conversationId: conv, nonce, sentAt: i + 10 }),
        { nonce, input: input(nonce), createdAt: i + 1 },
      );
    }
    await corrupt('outbox', (row) => row.nonce === 'bad');

    expect((await repo.listOutbox()).map((e) => e.nonce)).toEqual(['good']);
    // Nothing is deleted because it could not be read.
    expect(await rows('outbox', (all) => all.length)).toBe(2);
    expect(await repo.get(pendingMessageId('bad'))).toBeDefined();
  });

  it('a wrong key reads nothing and deletes nothing; the right key reads it all again', async () => {
    const name = `snowdrop-integrity-${++dbCounter}`;
    const keyA = randomKey();
    const withA = await IdbMessageRepository.open(name, await webCryptoCipher(keyA.slice()));
    const file = new File([new Uint8Array([1, 2, 3])], 'p.png', { type: 'image/png' });
    await withA.stageOutgoing(
      makeMessage({ id: pendingMessageId('q1'), conversationId: conv, nonce: 'q1' }),
      {
        nonce: 'q1',
        input: {
          conversationId: conv,
          body: 'queued',
          ranges: [],
          attachments: [{ fileName: 'p.png', contentType: 'image/png', data: file }],
        },
        createdAt: 1,
      },
    );
    withA.close();

    const count = async (store: string): Promise<number> => {
      const raw = await openDB(name);
      const n = await raw.count(store);
      raw.close();
      return n;
    };
    const withB = await IdbMessageRepository.open(name, await webCryptoCipher(randomKey()));
    expect(await withB.listOutbox()).toEqual([]);
    // Restoring (and deleting a conversation) under the wrong key leaves every row.
    await withB.deleteConversation(conv);
    withB.close();
    expect(await count('outbox')).toBe(1);
    expect(await count('outboxAttachments')).toBe(1);
    expect(await count('messages')).toBe(1);

    repo = await IdbMessageRepository.open(name, await webCryptoCipher(keyA.slice()));
    const [entry] = await repo.listOutbox();
    expect(entry).toMatchObject({ nonce: 'q1', input: { body: 'queued' } });
    expect(entry?.attachmentsLost).toBeFalsy();
    expect(await repo.get(pendingMessageId('q1'))).toBeDefined();
  });
});
