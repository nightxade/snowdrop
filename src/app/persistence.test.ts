import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { mergeDuplicate } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { createMemoryStorage, plaintextCipher, webCryptoCipher } from '@/core/persistence';
import { createPersistence, discardUnreadableWebCache } from './persistence';

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
let dbCounter = 0;

describe('createPersistence', () => {
  it('wires a hydrated keyValue store and a working repository, with a real cipher', async () => {
    const cipher = await webCryptoCipher(randomKey());
    const storage = createMemoryStorage();
    const { storage: kv, repository } = await createPersistence({
      cipher,
      storage,
      dbName: `snowdrop-persistence-test-${++dbCounter}`,
    });

    kv.setItem('snowdrop.settings', 'hello');
    expect(kv.getItem('snowdrop.settings')).toBe('hello');

    const conversationId = conversationIdFor('c');
    await repository.upsert(makeMessage({ conversationId, body: 'hi' }), mergeDuplicate);
    expect((await repository.latest(conversationId))?.body).toBe('hi');
  });

  it('also works with plaintextCipher (browser/dev mode)', async () => {
    const { storage: kv, repository } = await createPersistence({
      cipher: plaintextCipher(),
      storage: createMemoryStorage(),
      dbName: `snowdrop-persistence-test-${++dbCounter}`,
    });
    kv.setItem('k', 'v');
    expect(kv.getItem('k')).toBe('v');
    const conversationId = conversationIdFor('c2');
    await repository.upsert(makeMessage({ conversationId, body: 'hey' }), mergeDuplicate);
    expect((await repository.latest(conversationId))?.body).toBe('hey');
  });
});

describe('discardUnreadableWebCache', () => {
  it('removes sealed values and keeps legacy plaintext', async () => {
    const storage = createMemoryStorage({ sealed: 'sd1:AAAA', legacy: '{"v":1}' });
    await discardUnreadableWebCache({ storage, dbName: 'discard-test' });
    expect(storage.getItem('sealed')).toBeNull();
    expect(storage.getItem('legacy')).toBe('{"v":1}');
  });
});
