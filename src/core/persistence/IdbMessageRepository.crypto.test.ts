/**
 * Encryption-specific behaviour of IdbMessageRepository: what actually lands
 * on disk (docs/ENCRYPTION.md, "Web cache"), and the v1 → v2 migration that
 * clears the old plaintext schema rather than attempting an async-crypto
 * migration inside IndexedDB's versionchange transaction (see the "why" in
 * IdbMessageRepository.ts's file header).
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeDuplicate, messageId } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { utf8Encode, webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
let dbCounter = 0;
const nextDbName = (): string => `snowdrop-crypto-test-${++dbCounter}`;

describe('IdbMessageRepository encryption', () => {
  let repo: IdbMessageRepository | undefined;

  afterEach(() => {
    repo?.close();
    repo = undefined;
  });

  it('stores no plaintext body or conversation id in the raw records', async () => {
    const name = nextDbName();
    const cipher = await webCryptoCipher(randomKey());
    repo = await IdbMessageRepository.open(name, cipher);
    const conversationId = conversationIdFor('super-secret-group');
    const secretBody = 'the launch code is 4815162342';
    await repo.upsert(
      makeMessage({ conversationId, authorId: 'agent-smith', body: secretBody }),
      mergeDuplicate,
    );
    await repo.setReadCursor(conversationId, 1);

    // Inspect the raw rows, bypassing the repository entirely.
    const raw = await openDB(name, 3);
    const messageRows = await raw.getAll('messages');
    const cursorRows = await raw.getAll('readCursors');
    raw.close();

    expect(messageRows).toHaveLength(1);
    const row = messageRows[0] as Record<string, unknown>;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(secretBody);
    expect(serialized).not.toContain('agent-smith');
    expect(serialized).not.toContain('super-secret-group');
    expect(serialized).not.toContain(conversationId);
    // The sidecar id/conversationKey fields are blinded, not the plaintext ids.
    expect(String(row.id)).not.toContain('agent-smith');
    expect(row.conversationKey).not.toBe(conversationId);
    expect(row.payload).toBeInstanceOf(Uint8Array);

    expect(cursorRows).toHaveLength(1);
    const cursorSerialized = JSON.stringify(cursorRows[0]);
    expect(cursorSerialized).not.toContain('super-secret-group');
    expect(cursorSerialized).not.toContain(conversationId);
  });

  it('clears v1 (plaintext) data on upgrade to v2 instead of migrating it', async () => {
    const name = nextDbName();

    // Build a v1 database exactly as the pre-encryption schema did.
    const v1 = await openDB(name, 1, {
      upgrade(database) {
        const messages = database.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('byConversationSeq', ['conversationId', 'seq']);
        messages.createIndex('byMention', 'mentionIds', { multiEntry: true });
        messages.createIndex('byExpiresAt', 'expiresAt');
        database.createObjectStore('readCursors', { keyPath: 'conversationId' });
        database.createObjectStore('meta', { keyPath: 'key' });
        database.createObjectStore('outbox', { keyPath: 'nonce' });
      },
    });
    const conversationId = conversationIdFor('old-group');
    await v1.put('messages', {
      id: messageId('old-author', 100),
      conversationId,
      seq: 1,
      body: 'plaintext from before encryption existed',
      mentionIds: [],
    });
    await v1.put('meta', { key: 'seq', min: 1, max: 1 });
    await v1.put('readCursors', { conversationId, seq: 1 });
    v1.close();

    // Opening at v2 (the encrypted schema) runs the migration.
    const cipher = await webCryptoCipher(randomKey());
    repo = await IdbMessageRepository.open(name, cipher);

    expect(await repo.count(conversationId)).toBe(0);
    expect((await repo.getReadCursors()).size).toBe(0);
    expect(await repo.listOutbox()).toEqual([]);

    // The repository is fully usable afterwards, on the new (encrypted) schema.
    const seq = await repo.allocateSeq();
    expect(seq).toBe(1);
    await repo.upsert(
      makeMessage({ conversationId, body: 'fresh after migration' }),
      mergeDuplicate,
    );
    expect((await repo.latest(conversationId))?.body).toBe('fresh after migration');
  });

  it('drops one corrupted row among good ones, with a single aggregated warning (no contents)', async () => {
    const name = nextDbName();
    const cipher = await webCryptoCipher(randomKey());
    repo = await IdbMessageRepository.open(name, cipher);
    const conversationId = conversationIdFor('mixed-group');

    await repo.upsert(
      makeMessage({ conversationId, authorId: 'a', sentAt: 1, body: 'first' }),
      mergeDuplicate,
    );
    const { message: bad } = await repo.upsert(
      makeMessage({
        conversationId,
        authorId: 'b',
        sentAt: 2,
        body: 'secret body that must never be logged',
      }),
      mergeDuplicate,
    );
    await repo.upsert(
      makeMessage({ conversationId, authorId: 'c', sentAt: 3, body: 'second' }),
      mergeDuplicate,
    );

    // Tamper with the middle row's ciphertext directly, bypassing the
    // repository — the AEAD tag no longer matches, so decrypting it throws.
    const badKey = await cipher.blindId(bad.id);
    const raw = await openDB(name, 3);
    const row = (await raw.get('messages', badKey)) as Record<string, unknown>;
    expect(row).toBeDefined();
    const payload = new Uint8Array(row.payload as Uint8Array);
    payload[0] = (payload[0] ?? 0) ^ 0xff;
    await raw.put('messages', { ...row, payload });
    raw.close();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const messages = await repo.page(conversationId, { limit: 10 });
      expect(messages.map((m) => m.body)).toEqual(['first', 'second']);
      expect(warn).toHaveBeenCalledTimes(1);
      const [warning] = warn.mock.calls[0] as unknown[];
      expect(warning).toMatch(/dropped 1/iu);
      expect(warning).not.toContain('secret body');
    } finally {
      warn.mockRestore();
    }
  });

  it('(regression) flags attachments as lost for a pre-fix outbox row instead of losing the message', async () => {
    const name = nextDbName();
    const cipher = await webCryptoCipher(randomKey());
    repo = await IdbMessageRepository.open(name, cipher);

    // A row written before attachment persistence existed: `JSON.stringify(Blob)`
    // serialised to `{}`, and there's no `attachmentCount` to say bytes live
    // elsewhere — exactly what a pre-fix outbox entry looked like on disk.
    const nonce = 'legacy-1';
    const legacyInput = {
      conversationId: conversationIdFor('legacy'),
      body: 'hi, with a photo',
      ranges: [],
      attachments: [{}],
    };
    const payload = await cipher.encrypt(utf8Encode(JSON.stringify({ input: legacyInput })), nonce);
    const raw = await openDB(name, 3);
    await raw.put('outbox', { nonce, createdAt: 1, payload });
    raw.close();

    const [entry] = await repo.listOutbox();
    expect(entry).toMatchObject({
      nonce,
      attachmentsLost: true,
      input: { body: 'hi, with a photo', attachments: [] },
    });
  });
});
