/** Opening the history database, batch upserts and the purge listing, against a real (fake-indexeddb) database. */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeDuplicate } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

const randomKey = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));
let dbCounter = 0;
const nextName = () => `snowdrop-open-${++dbCounter}`;
const conv = conversationIdFor('open');

describe('IdbMessageRepository: opening', () => {
  const repos: IdbMessageRepository[] = [];
  afterEach(() => {
    for (const repo of repos.splice(0)) repo.close();
  });

  it('keeps its connection usable while a newer version waits to open', async () => {
    const name = nextName();
    const repo = await IdbMessageRepository.open(name);
    repos.push(repo);
    const newer = openDB(name, 99);
    const m = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 1, body: 'still here' });
    await repo.upsert(m, mergeDuplicate);
    expect((await repo.get(m.id))?.body).toBe('still here');
    repo.close();
    (await newer).close();
  });

  it('fails clearly when it is blocked by an older connection, and drops the late connection', async () => {
    const name = nextName();
    const holder = await openDB(name, 1, {
      upgrade(database) {
        for (const store of ['messages', 'readCursors', 'meta', 'outbox']) {
          database.createObjectStore(store);
        }
      },
    });
    await expect(IdbMessageRepository.open(name)).rejects.toThrow(/another Snowdrop window/);
    holder.close();
    // The abandoned open completes once the holder lets go, and must not keep the database open.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const check = await openDB(name, 99);
    check.close();
  });

  it('explains a downgrade', async () => {
    const name = nextName();
    (await openDB(name, 99)).close();
    await expect(IdbMessageRepository.open(name)).rejects.toThrow(/newer version of Snowdrop/);
  });
});

describe('IdbMessageRepository: batches and purge', () => {
  let repo: IdbMessageRepository | undefined;
  afterEach(() => {
    repo?.close();
    repo = undefined;
  });

  async function setup() {
    const name = nextName();
    repo = await IdbMessageRepository.open(name, await webCryptoCipher(randomKey()));
    return { repo, name };
  }

  it('folds a duplicate id in one batch like two upserts in a row', async () => {
    const { repo } = await setup();
    const first = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 1, body: 'one' });
    const other = makeMessage({ conversationId: conv, authorId: 'x', sentAt: 2, body: 'other' });
    const out = await repo.upsertMany([first, other, { ...first, body: 'two' }], {
      backfill: false,
      merge: mergeDuplicate,
    });
    const sequential = await setup();
    await sequential.repo.upsert(first, mergeDuplicate);
    await sequential.repo.upsert(other, mergeDuplicate);
    const again = await sequential.repo.upsert({ ...first, body: 'two' }, mergeDuplicate);
    expect(out[2]).toEqual(again.message);
    expect(out[2]!.seq).toBe(out[0]!.seq);
    expect(out[1]!.seq).not.toBe(out[0]!.seq);
    expect((await repo.get(first.id))?.body).toBe(again.message.body);
    sequential.repo.close();
  });

  it('purge listing is not starved by unreadable expired rows ahead of readable ones', async () => {
    const { repo, name } = await setup();
    const bad = [1, 2, 3].map((i) =>
      makeMessage({ conversationId: conv, authorId: 'x', sentAt: i, body: 'b', expiresAt: i }),
    );
    const good = makeMessage({
      conversationId: conv,
      authorId: 'x',
      sentAt: 10,
      body: 'g',
      expiresAt: 10,
    });
    await repo.upsertMany([...bad, good], { backfill: false, merge: mergeDuplicate });
    const raw = await openDB(name);
    for (const row of (await raw.getAllFromIndex('messages', 'byExpiresAt')) as {
      expiresAt: number;
    }[]) {
      if (row.expiresAt !== 10)
        await raw.put('messages', { ...row, payload: new Uint8Array(48).fill(7) });
    }
    raw.close();
    const listed = await repo.expired(100, 2);
    expect(listed.map((m) => m.body)).toEqual(['g']);
  });

  it('purge listing with a limit of one resumes past an unreadable first row', async () => {
    const { repo, name } = await setup();
    const rows = [1, 2, 3].map((i) =>
      makeMessage({
        conversationId: conv,
        authorId: 'x',
        sentAt: i,
        body: i === 3 ? 'g' : 'b',
        expiresAt: i,
      }),
    );
    await repo.upsertMany(rows, { backfill: false, merge: mergeDuplicate });
    const raw = await openDB(name);
    for (const row of (await raw.getAllFromIndex('messages', 'byExpiresAt')) as {
      expiresAt: number;
    }[]) {
      if (row.expiresAt !== 3)
        await raw.put('messages', { ...row, payload: new Uint8Array(48).fill(7) });
    }
    raw.close();
    expect((await repo.expired(100, 1)).map((m) => m.body)).toEqual(['g']);
  });

  it('purge listing reads only as many rows as it needs, and pages past unreadable ones', async () => {
    const { repo } = await setup();
    const rows = Array.from({ length: 6 }, (_, i) =>
      makeMessage({
        conversationId: conv,
        authorId: 'x',
        sentAt: i + 1,
        body: `m${i}`,
        expiresAt: 5,
      }),
    );
    await repo.upsertMany(rows, { backfill: false, merge: mergeDuplicate });
    const decode = vi.spyOn(
      repo as unknown as { fromRows: (rows: readonly unknown[]) => Promise<unknown[]> },
      'fromRows',
    );
    // It walks the index with a cursor rather than loading every expired row.
    const db = (repo as unknown as { db: { getAllFromIndex: (...args: unknown[]) => unknown } }).db;
    const loadAll = vi.spyOn(db, 'getAllFromIndex');
    expect(await repo.expired(100, 2)).toHaveLength(2);
    expect(loadAll).not.toHaveBeenCalled();
    expect(decode.mock.calls.flatMap(([r]) => r)).toHaveLength(2);
    // Ties on the expiry time page correctly: all six come out across pages, none twice.
    decode.mockClear();
    const all = await repo.expired(100, 4);
    expect(new Set(all.map((m) => m.id)).size).toBe(4);
    const everyone = await repo.expired(100, 50);
    expect(everyone).toHaveLength(6);
    expect(new Set(everyone.map((m) => m.id)).size).toBe(6);
  });
});
