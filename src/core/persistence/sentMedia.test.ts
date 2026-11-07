import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { applyDelete, mergeDuplicate, mergeOutgoingCommit, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { plaintextCipher, utf8Encode, webCryptoCipher, type RecordCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';
import { MemoryMessageRepository } from './MemoryMessageRepository';
import type { MessageRepository } from './MessageRepository';

const a = conversationIdFor('a');
const b = conversationIdFor('b');
const BYTES = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16]);

let counter = 0;
const implementations: [string, () => Promise<MessageRepository>][] = [
  ['memory', () => Promise.resolve(new MemoryMessageRepository())],
  ['indexeddb', () => IdbMessageRepository.open(`snowdrop-media-${++counter}`)],
  [
    'indexeddb+webCryptoCipher',
    async () =>
      IdbMessageRepository.open(
        `snowdrop-media-${++counter}`,
        await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32))),
      ),
  ],
];

const sent = (conversationId: typeof a, sentAt: number, attachmentId: string): Message =>
  makeMessage({
    conversationId,
    authorId: 'me',
    sentAt,
    status: 'sent',
    attachments: [{ id: attachmentId, contentType: 'image/png', original: true }],
  });

async function commit(repo: MessageRepository, message: Message, attachmentId: string) {
  await repo.commitOutgoing('n', message, mergeOutgoingCommit, [
    { id: attachmentId, data: new Blob([BYTES]) },
  ]);
}

async function bytesOf(repo: MessageRepository, id: string): Promise<number[] | undefined> {
  const blob = await repo.readSentMedia(id, 'image/png');
  return blob ? [...new Uint8Array(await blob.arrayBuffer())] : undefined;
}

describe.each(implementations)('kept originals of sent images (%s)', (_name, create) => {
  it('stores the original with the committed message and reads it back typed', async () => {
    const repo = await create();
    await commit(repo, sent(a, 1, 'local:1'), 'local:1');
    expect(await bytesOf(repo, 'local:1')).toEqual([...BYTES]);
    expect((await repo.readSentMedia('local:1', 'image/png'))?.type).toBe('image/png');
    expect(await repo.readSentMedia('local:other', 'image/png')).toBeUndefined();
  });

  it('removes it when the message is deleted for me or expires', async () => {
    const repo = await create();
    const message = sent(a, 1, 'local:1');
    await commit(repo, message, 'local:1');
    await repo.delete(message.id);
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });

  it('removes it when the message is deleted for everyone', async () => {
    const repo = await create();
    const message = sent(a, 1, 'local:1');
    await commit(repo, message, 'local:1');
    // Another edit leaves it alone.
    await repo.update(message.id, (m) => ({ ...m, body: 'edited' }));
    expect(await bytesOf(repo, 'local:1')).toBeDefined();
    await repo.update(message.id, (m) => applyDelete(m));
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });

  it('removes it when a re-delivery of the message drops the attachment', async () => {
    const repo = await create();
    const message = sent(a, 1, 'local:1');
    await commit(repo, message, 'local:1');
    await repo.upsert({ ...message, deleted: true, attachments: [] }, (_, incoming) => incoming);
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
    await commit(repo, sent(a, 2, 'local:2'), 'local:2');
    await repo.upsertMany([{ ...sent(a, 2, 'local:2'), attachments: [] }], {
      backfill: false,
      merge: (_, incoming) => incoming,
    });
    expect(await bytesOf(repo, 'local:2')).toBeUndefined();
  });

  it("removes a conversation's originals with the conversation, and only that one's", async () => {
    const repo = await create();
    await commit(repo, sent(a, 1, 'local:1'), 'local:1');
    await commit(repo, sent(b, 2, 'local:2'), 'local:2');
    await repo.deleteConversation(a);
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
    expect(await bytesOf(repo, 'local:2')).toBeDefined();
  });

  it('removes everything when history is cleared', async () => {
    const repo = await create();
    await commit(repo, sent(a, 1, 'local:1'), 'local:1');
    await repo.clear();
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });

  it('keeps nothing for a send that is not committed (discarded)', async () => {
    const repo = await create();
    await repo.discardOutgoing('n');
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
    // And a plain merge is not a way to gain one.
    await repo.upsert(sent(a, 3, 'local:3'), mergeDuplicate);
    expect(await bytesOf(repo, 'local:3')).toBeUndefined();
  });
});

describe('kept originals at rest', () => {
  it('are encrypted in the database, under blinded keys', async () => {
    const name = `snowdrop-media-${++counter}`;
    const repo = await IdbMessageRepository.open(
      name,
      await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32))),
    );
    await commit(repo, sent(a, 1, 'local:1'), 'local:1');
    const raw = await openDB(name);
    const rows = (await raw.getAll('sentMedia')) as { id: string; payload: Uint8Array }[];
    raw.close();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toContain('local');
    const stored = [...(rows[0]?.payload ?? [])].join(',');
    expect(stored).not.toContain([...BYTES].join(','));
  });
});

describe('upgrading a populated v5 database', () => {
  it('keeps every message, the sequence, the outbox, the cursors and the outbox bytes, and adds an empty sentMedia', async () => {
    const name = `snowdrop-media-${++counter}`;
    const cipher = await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32)));
    const message = makeMessage({
      conversationId: a,
      authorId: 'ana',
      sentAt: 10,
      seq: 7,
      body: 'from v5',
      historyCursor: 'snapshot:3',
    });

    // A v5 database as the previous release wrote it.
    const v5 = await openDB(name, 5, {
      upgrade(database) {
        const messages = database.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('byConversationSeq', ['conversationKey', 'seq']);
        messages.createIndex('byMention', 'mentionIds', { multiEntry: true });
        messages.createIndex('byExpiresAt', 'expiresAt');
        messages.createIndex('bySeq', 'seq');
        database.createObjectStore('readCursors', { keyPath: 'id' });
        database.createObjectStore('meta', { keyPath: 'key' });
        database.createObjectStore('outbox', { keyPath: 'nonce' });
        database.createObjectStore('outboxAttachments', { keyPath: 'id' });
      },
    });
    const id = await cipher.blindId(message.id);
    const conversationKey = await cipher.blindId(a);
    await v5.put('messages', {
      id,
      conversationKey,
      seq: 7,
      mentionIds: [],
      payload: await cipher.encrypt(utf8Encode(JSON.stringify(message)), id),
    });
    await v5.put('meta', { key: 'seq', min: 7, max: 7 });
    await v5.put('readCursors', {
      id: conversationKey,
      payload: await cipher.encrypt(
        utf8Encode(JSON.stringify({ conversationId: a, seq: 7 })),
        conversationKey,
      ),
    });
    const attId = 'n5:0';
    await v5.put('outbox', {
      nonce: 'n5',
      createdAt: 5,
      attachmentCount: 1,
      payload: await cipher.encrypt(
        utf8Encode(
          JSON.stringify({
            input: {
              conversationId: a,
              body: 'pending',
              ranges: [],
              attachments: [{ fileName: 'f.png', contentType: 'image/png' }],
            },
          }),
        ),
        'n5',
      ),
    });
    await v5.put('outboxAttachments', {
      id: attId,
      payload: await cipher.encrypt(BYTES, attId),
    });
    v5.close();

    const repo = await IdbMessageRepository.open(name, cipher);
    expect(await repo.get(message.id)).toMatchObject({
      body: 'from v5',
      seq: 7,
      historyCursor: 'snapshot:3',
    });
    expect((await repo.page(a, { limit: 10 })).map((m) => m.id)).toEqual([message.id]);
    expect(await repo.allocateSeq()).toBe(8);
    expect([...(await repo.getReadCursors())]).toEqual([[a, 7]]);
    const [entry] = await repo.listOutbox();
    expect(entry).toMatchObject({ nonce: 'n5', input: { body: 'pending' } });
    expect(entry?.attachmentsLost).toBeUndefined();
    const file = entry?.input.attachments?.[0]?.data;
    expect([...new Uint8Array((await file?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([
      ...BYTES,
    ]);
    // The new store is there, and empty.
    const raw = await openDB(name);
    expect([...raw.objectStoreNames]).toContain('sentMedia');
    expect(await raw.count('sentMedia')).toBe(0);
    raw.close();
    expect(await repo.readSentMedia('anything', 'image/png')).toBeUndefined();
  });
});

describe.each(implementations)('kept originals and deleted messages (%s)', (_name, create) => {
  it('does not re-create an original for a message already deleted for everyone', async () => {
    const repo = await create();
    const message = sent(a, 1, 'local:1');
    await repo.upsert(applyDelete(message), mergeDuplicate);
    const { message: stored } = await repo.commitOutgoing('n', message, mergeOutgoingCommit, [
      { id: 'local:1', data: new Blob([BYTES]) },
    ]);
    expect(stored.attachments.some((x) => x.original === true)).toBe(false);
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });
});

describe('kept originals when the store refuses', () => {
  function flaky() {
    const real = plaintextCipher();
    const fail = { encrypt: false, blind: false };
    const cipher: RecordCipher = {
      encrypt: (plain, aad) =>
        fail.encrypt && plain.length === BYTES.length
          ? Promise.reject(new Error('QuotaExceededError'))
          : real.encrypt(plain, aad),
      decrypt: (c, aad) => real.decrypt(c, aad),
      blindId: (id) =>
        fail.blind && id === 'local:1' ? Promise.reject(new Error('boom')) : real.blindId(id),
    };
    return { cipher, fail };
  }

  it('still records the sent message, with the preview standing in', async () => {
    const { cipher, fail } = flaky();
    const repo = await IdbMessageRepository.open(`snowdrop-media-${++counter}`, cipher);
    fail.encrypt = true;
    const message = sent(a, 1, 'local:1');
    const { message: stored } = await repo.commitOutgoing('n', message, mergeOutgoingCommit, [
      { id: 'local:1', data: new Blob([BYTES]) },
    ]);
    expect(stored.attachments[0]?.original).toBeUndefined();
    expect((await repo.get(message.id))?.attachments[0]?.original).toBeUndefined();
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });

  it('keeps the ones that fit when another is refused', async () => {
    const { cipher, fail } = flaky();
    const repo = await IdbMessageRepository.open(`snowdrop-media-${++counter}`, cipher);
    const message = {
      ...sent(a, 1, 'local:1'),
      attachments: [
        { id: 'local:1', contentType: 'image/png', original: true },
        { id: 'local:2', contentType: 'image/png', original: true },
      ],
    };
    // Only the first write is refused.
    let calls = 0;
    const encrypt = cipher.encrypt.bind(cipher);
    cipher.encrypt = (plain, aad) =>
      plain.length === BYTES.length && ++calls === 1
        ? Promise.reject(new Error('Quota'))
        : encrypt(plain, aad);
    fail.encrypt = false;
    const { message: stored } = await repo.commitOutgoing('n', message, mergeOutgoingCommit, [
      { id: 'local:1', data: new Blob([BYTES]) },
      { id: 'local:2', data: new Blob([BYTES]) },
    ]);
    expect(stored.attachments.map((x) => x.original)).toEqual([undefined, true]);
    expect(await bytesOf(repo, 'local:2')).toBeDefined();
  });

  it('removes the original in the same transaction as the message: a failure leaves both', async () => {
    const { cipher, fail } = flaky();
    const repo = await IdbMessageRepository.open(`snowdrop-media-${++counter}`, cipher);
    const message = sent(a, 1, 'local:1');
    await commit(repo, message, 'local:1');
    fail.blind = true;
    await expect(repo.delete(message.id)).rejects.toThrow();
    fail.blind = false;
    expect(await repo.get(message.id)).toBeDefined();
    expect(await bytesOf(repo, 'local:1')).toBeDefined();
    await repo.delete(message.id);
    expect(await bytesOf(repo, 'local:1')).toBeUndefined();
  });
});
