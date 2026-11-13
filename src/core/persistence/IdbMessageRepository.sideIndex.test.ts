/**
 * The encrypted side indexes behind `pendingHistoryTimers`, `pinned` and the
 * gallery: they must always equal a full scan, stay maintained by every write
 * path, build lazily, and decrypt only the rows they list.
 */
import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GALLERY_KINDS,
  hasGalleryItems,
  mergeDuplicate,
  pendingMessageId,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { plaintextCipher, webCryptoCipher, type RecordCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

const a = conversationIdFor('side-a');
const b = conversationIdFor('side-b');
let counter = 0;
const nextName = () => `snowdrop-side-${++counter}`;

const incoming = (partial: Partial<Message>): Message => {
  const { seq: _seq, ...m } = makeMessage(partial);
  return m;
};
const withFile = (partial: Partial<Message>, contentType = 'image/png'): Message =>
  incoming({ attachments: [{ id: `att-${++counter}`, contentType }], ...partial });
const merge = { backfill: false, merge: mergeDuplicate };
const timer = (partial: Partial<Message> = {}): Message =>
  incoming({ historyCursor: 'c', expiresAfterReadMs: 5000, ...partial });

const repos: IdbMessageRepository[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  vi.restoreAllMocks();
});

async function open(name = nextName(), cipher: RecordCipher = plaintextCipher()) {
  const repo = await IdbMessageRepository.open(name, cipher);
  repos.push(repo);
  return repo;
}

/** The side rows as stored, readable because the plaintext cipher leaves payloads as JSON. */
async function sideRows(name: string): Promise<Record<string, { id: string; seq: number }[]>> {
  const raw = await openDB(name);
  try {
    const out: Record<string, { id: string; seq: number }[]> = {};
    for (const row of (await raw.getAll('sideIndex')) as { id: string; payload: Uint8Array }[]) {
      const parsed = JSON.parse(new TextDecoder().decode(row.payload)) as {
        built: boolean;
        entries: { id: string; seq: number }[];
      };
      expect(parsed.built).toBe(true);
      out[row.id] = parsed.entries;
    }
    return out;
  } finally {
    raw.close();
  }
}

/** What a full scan of the conversation says each query should return. */
async function expected(repo: IdbMessageRepository, conversationId: ConversationId) {
  const all = await repo.page(conversationId, { limit: 10_000 });
  const newest = [...all].reverse();
  return {
    pinned: newest.filter((m) => m.pinned === true && !m.deleted).map((m) => m.id),
    media: Object.fromEntries(
      GALLERY_KINDS.map((k) => [k, newest.filter((m) => hasGalleryItems(m, k)).map((m) => m.id)]),
    ),
  };
}

async function actual(repo: IdbMessageRepository, conversationId: ConversationId) {
  const ids = (ms: Message[]) => ms.map((m) => m.id);
  return {
    pinned: ids(await repo.pinned(conversationId, 1000)),
    media: Object.fromEntries(
      await Promise.all(
        GALLERY_KINDS.map(async (k): Promise<[string, string[]]> => [
          k,
          ids(await repo.media(conversationId, k, { limit: 1000 })),
        ]),
      ),
    ),
  };
}

async function buildAll(repo: IdbMessageRepository) {
  for (const c of [a, b]) {
    await repo.pinned(c, 1);
    for (const k of GALLERY_KINDS) {
      await repo.media(c, k, { limit: 1000 });
    }
  }
  await repo.pendingHistoryTimers();
}

describe('side indexes equal a full scan', () => {
  it('through pins, unpins, deletions, every kind, timers and edits that drop an attachment', async () => {
    const repo = await open();
    await buildAll(repo); // empty and built: later writes must be maintained, not rescanned
    const [m1, m2, m3, m4, m5, m6] = await repo.upsertMany(
      [
        withFile({ conversationId: a, sentAt: 1, pinned: true }),
        withFile({ conversationId: a, sentAt: 2 }, 'video/mp4'),
        withFile({ conversationId: a, sentAt: 3 }, 'audio/mpeg'),
        withFile({ conversationId: a, sentAt: 4 }, 'application/pdf'),
        incoming({
          conversationId: a,
          sentAt: 5,
          previews: [{ url: 'https://example.com', title: 't' }],
          pinned: true,
        }),
        withFile({ conversationId: b, sentAt: 6, pinned: true }),
      ],
      merge,
    );
    await repo.upsert(timer({ conversationId: a, sentAt: 7 }), mergeDuplicate);
    await repo.update(m1!.id, (m) => ({ ...m, pinned: false })); // unpin
    await repo.update(m5!.id, (m) => ({ ...m, deleted: true })); // delete for everyone
    await repo.update(m2!.id, (m) => ({ ...m, attachments: [] })); // edit removes the attachment
    await repo.update(m3!.id, (m) => ({ ...m, pinned: true }));
    await repo.delete(m4!.id);
    await repo.update(m6!.id, (m) => ({ ...m, pinned: false }));
    for (const c of [a, b]) expect(await actual(repo, c)).toEqual(await expected(repo, c));
    expect((await repo.pendingHistoryTimers()).map((m) => m.sentAt)).toEqual([7]);
  });

  it('gives the same answers for an index built lazily over existing rows', async () => {
    const name = nextName();
    const repo = await open(name);
    await repo.upsertMany(
      [
        withFile({ conversationId: a, sentAt: 1, pinned: true }),
        withFile({ conversationId: a, sentAt: 2 }, 'application/pdf'),
        incoming({ conversationId: a, sentAt: 3, deleted: true, pinned: true }),
        timer({ conversationId: b, sentAt: 4 }),
        timer({ conversationId: b, sentAt: 5, expiresAt: 99 }),
      ],
      merge,
    );
    expect(await actual(repo, a)).toEqual(await expected(repo, a));
    expect((await repo.pendingHistoryTimers()).map((m) => m.sentAt)).toEqual([4]);
  });
});

describe('side index maintenance', () => {
  async function built() {
    const name = nextName();
    const repo = await open(name);
    await buildAll(repo);
    return { repo, name };
  }
  const pendingKey = 'side:pending-timers';
  const pinnedKey = (c: string) => `side:pinned:${c}`;
  const mediaKey = (k: string, c: string) => `side:media:${k}:${c}`;

  it('upsert and upsertMany add members; update and delete remove them', async () => {
    const { repo, name } = await built();
    const one = await repo.upsert(
      withFile({ conversationId: a, sentAt: 1, pinned: true }),
      mergeDuplicate,
    );
    const many = await repo.upsertMany([timer({ conversationId: a, sentAt: 2 })], merge);
    let rows = await sideRows(name);
    expect(rows[pinnedKey(a)]?.map((e) => e.id)).toEqual([one.message.id]);
    expect(rows[mediaKey('media', a)]?.map((e) => e.id)).toEqual([one.message.id]);
    expect(rows[pendingKey]?.map((e) => e.id)).toEqual([many[0]!.id]);
    await repo.update(one.message.id, (m) => ({ ...m, pinned: false }));
    await repo.update(many[0]!.id, (m) => ({ ...m, expiresAt: 10 }));
    rows = await sideRows(name);
    expect(rows[pinnedKey(a)]).toEqual([]);
    expect(rows[pendingKey]).toEqual([]);
    await repo.delete(one.message.id);
    expect((await sideRows(name))[mediaKey('media', a)]).toEqual([]);
  });

  it('an expiry purge (delete of an expired message) removes it from the index', async () => {
    const { repo, name } = await built();
    await repo.upsert(withFile({ conversationId: a, sentAt: 1, expiresAt: 5 }), mergeDuplicate);
    expect((await sideRows(name))[mediaKey('media', a)]).toHaveLength(1);
    for (const m of await repo.expired(10, 10)) await repo.delete(m.id);
    expect((await sideRows(name))[mediaKey('media', a)]).toEqual([]);
  });

  it('staging, committing and discarding a send keep the lists right', async () => {
    const { repo, name } = await built();
    const pending = withFile({ conversationId: a, sentAt: 1, id: pendingMessageId('n1') });
    const entry = (nonce: string) => ({
      nonce,
      createdAt: 1,
      input: { conversationId: a, body: 'x', ranges: [] },
    });
    await repo.stageOutgoing(pending, entry('n1'));
    expect((await sideRows(name))[mediaKey('media', a)]?.map((e) => e.id)).toEqual([pending.id]);
    const final = { ...pending, id: makeMessage({ conversationId: a, sentAt: 1 }).id };
    await repo.commitOutgoing('n1', final, mergeDuplicate);
    expect((await sideRows(name))[mediaKey('media', a)]?.map((e) => e.id)).toEqual([final.id]);
    const second = withFile({ conversationId: a, sentAt: 2, id: pendingMessageId('n2') });
    await repo.stageOutgoing(second, entry('n2'));
    await repo.discardOutgoing('n2');
    expect((await sideRows(name))[mediaKey('media', a)]?.map((e) => e.id)).toEqual([final.id]);
  });

  it('removing a conversation drops its lists and its imported timers only', async () => {
    const { repo, name } = await built();
    await repo.upsertMany(
      [
        withFile({ conversationId: a, sentAt: 1, pinned: true }),
        timer({ conversationId: a, sentAt: 2 }),
        timer({ conversationId: b, sentAt: 3 }),
      ],
      merge,
    );
    await repo.deleteConversation(a);
    const rows = await sideRows(name);
    expect(rows[pinnedKey(a)]).toBeUndefined();
    expect(rows[mediaKey('media', a)]).toBeUndefined();
    expect(rows[pendingKey]).toHaveLength(1);
    expect((await repo.pendingHistoryTimers()).map((m) => m.sentAt)).toEqual([3]);
  });

  it('clear removes every list', async () => {
    const { repo, name } = await built();
    await repo.upsert(withFile({ conversationId: a, sentAt: 1 }), mergeDuplicate);
    await repo.clear();
    expect(await sideRows(name)).toEqual({});
  });

  it('a transaction that aborts leaves the message and its lists untouched', async () => {
    const { repo, name } = await built();
    // eslint-disable-next-line @typescript-eslint/unbound-method -- called back with its own `this` below
    const real = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'sideIndex') throw new Error('refused');
      return real.apply(this, args);
    });
    const m = withFile({ conversationId: a, sentAt: 1, pinned: true });
    await expect(repo.upsert(m, mergeDuplicate)).rejects.toThrow('refused');
    put.mockRestore();
    expect(await repo.page(a, { limit: 10 })).toEqual([]);
    expect((await sideRows(name))[pinnedKey(a)]).toEqual([]);
  });
});

describe('lazy build', () => {
  /** A cipher that counts how many payloads are opened. */
  async function counting() {
    const inner = await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32)));
    const decrypt = vi.fn(inner.decrypt.bind(inner));
    return { cipher: { ...inner, decrypt } as RecordCipher, decrypt };
  }

  it('scans once, then lists only its own rows, and later writes need no scan', async () => {
    const { cipher, decrypt } = await counting();
    const repo = await open(nextName(), cipher);
    const batch: Message[] = [];
    for (let i = 0; i < 60; i++) {
      batch.push(
        i % 20 === 0
          ? timer({ conversationId: a, sentAt: i + 1 })
          : incoming({ conversationId: a, sentAt: i + 1 }),
      );
    }
    await repo.upsertMany(batch, merge);
    decrypt.mockClear();
    expect(await repo.pendingHistoryTimers()).toHaveLength(3); // the one full scan
    expect(decrypt.mock.calls.length).toBeGreaterThanOrEqual(60);
    decrypt.mockClear();
    expect(await repo.pendingHistoryTimers()).toHaveLength(3);
    expect(decrypt.mock.calls.length).toBeLessThanOrEqual(3 + 1); // the three rows and the list
    await repo.upsert(timer({ conversationId: a, sentAt: 100 }), mergeDuplicate);
    decrypt.mockClear();
    expect(await repo.pendingHistoryTimers()).toHaveLength(4);
    expect(decrypt.mock.calls.length).toBeLessThanOrEqual(4 + 1);
  });

  it('builds a gallery list when the walk reaches the start, and not before', async () => {
    const name = nextName();
    const repo = await open(name);
    await repo.upsertMany(
      [withFile({ conversationId: a, sentAt: 1 }), incoming({ conversationId: a, sentAt: 2 })],
      merge,
    );
    expect(await sideRows(name)).toEqual({});
    await repo.media(a, 'media', { limit: 10 });
    expect(Object.keys(await sideRows(name))).toEqual(['side:media:media:' + a]);
  });
});

describe('drift', () => {
  it('drops and repairs an entry whose row no longer qualifies or is gone', async () => {
    const name = nextName();
    const repo = await open(name);
    const [x, y, z] = await repo.upsertMany(
      [
        withFile({ conversationId: a, sentAt: 1, pinned: true }),
        withFile({ conversationId: a, sentAt: 2, pinned: true }),
        withFile({ conversationId: a, sentAt: 3, pinned: true }),
      ],
      merge,
    );
    expect(await repo.pinned(a, 10)).toHaveLength(3);
    const raw = await openDB(name);
    const xRow = (await raw.get('messages', x!.id)) as { id: string; payload: Uint8Array };
    const plain = JSON.parse(new TextDecoder().decode(xRow.payload)) as Message;
    await raw.put('messages', {
      ...xRow,
      payload: new TextEncoder().encode(JSON.stringify({ ...plain, pinned: false })),
    });
    await raw.delete('messages', y!.id);
    raw.close();
    expect((await repo.pinned(a, 10)).map((m) => m.id)).toEqual([z!.id]);
    expect((await sideRows(name))[`side:pinned:${a}`]?.map((e) => e.id)).toEqual([z!.id]);
  });
});

describe('upgrade from version 6', () => {
  it('keeps existing rows and builds lists on first use', async () => {
    const name = nextName();
    const old = await openDB(name, 6, {
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
        database
          .createObjectStore('sentMedia', { keyPath: 'id' })
          .createIndex('byConversation', 'conversationKey');
      },
    });
    const m: Message = { ...makeMessage({ conversationId: a, sentAt: 1, pinned: true }), seq: 1 };
    await old.put('messages', {
      id: m.id,
      conversationKey: a,
      seq: 1,
      mentionIds: [],
      payload: new TextEncoder().encode(JSON.stringify(m)),
    });
    old.close();
    const repo = await open(name);
    expect((await repo.get(m.id))?.id).toBe(m.id);
    expect(await sideRows(name)).toEqual({});
    expect((await repo.pinned(a, 5)).map((x) => x.id)).toEqual([m.id]);
    expect((await sideRows(name))[`side:pinned:${a}`]?.map((e) => e.id)).toEqual([m.id]);
  });
});

/** A plaintext cipher (so side rows can be read raw) whose calls can be observed and held. */
function probeCipher() {
  const base = plaintextCipher();
  const probe = {
    sideDecrypts: 0,
    failSideEncrypt: false,
    /** Holds the next decrypt of a message row until `release` is called. */
    gate: undefined as { reached: Promise<void>; release: () => void } | undefined,
    arm() {
      let release: () => void = () => undefined;
      let reached: () => void = () => undefined;
      const gate = {
        reached: new Promise<void>((resolve) => {
          reached = resolve;
        }),
        release: () => {
          release();
        },
      };
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      probe.gate = gate;
      probe.hold = async () => {
        probe.gate = undefined;
        reached();
        await held;
      };
      return gate;
    },
    hold: undefined as (() => Promise<void>) | undefined,
  };
  const cipher: RecordCipher = {
    ...base,
    async decrypt(ciphertext, aad) {
      if (aad.startsWith('side:')) probe.sideDecrypts++;
      else if (probe.gate && probe.hold) await probe.hold();
      return base.decrypt(ciphertext, aad);
    },
    async encrypt(plain, aad) {
      if (probe.failSideEncrypt && aad.startsWith('side:')) throw new Error('refused');
      return base.encrypt(plain, aad);
    },
  };
  return { cipher, probe };
}

describe('writes during a lazy build', () => {
  it('are reflected in a pending-timers index built while they landed', async () => {
    const { cipher, probe } = probeCipher();
    const name = nextName();
    const repo = await open(name, cipher);
    const [kept, ended] = await repo.upsertMany(
      [timer({ conversationId: a, sentAt: 1 }), timer({ conversationId: a, sentAt: 2 })],
      merge,
    );
    const gate = probe.arm();
    const building = repo.pendingHistoryTimers();
    await gate.reached; // the scan is decrypting rows, outside the write queue
    const added = await repo.upsert(timer({ conversationId: a, sentAt: 3 }), mergeDuplicate);
    await repo.update(ended!.id, (m) => ({ ...m, expiresAt: 50 }));
    gate.release();
    const expectedIds = [kept!.id, added.message.id];
    expect((await building).map((m) => m.id).sort()).toEqual([...expectedIds].sort());
    expect((await sideRows(name))['side:pending-timers']?.map((e) => e.id).sort()).toEqual(
      [...expectedIds].sort(),
    );
    expect((await repo.pendingHistoryTimers()).map((m) => m.id).sort()).toEqual(
      [...expectedIds].sort(),
    );
  });

  it('are reflected in a gallery list stored by a walk that reached the start', async () => {
    const { cipher, probe } = probeCipher();
    const name = nextName();
    const repo = await open(name, cipher);
    const [old] = await repo.upsertMany([withFile({ conversationId: a, sentAt: 1 })], merge);
    const gate = probe.arm();
    const walking = repo.media(a, 'media', { limit: 10 });
    await gate.reached;
    const added = await repo.upsert(withFile({ conversationId: a, sentAt: 2 }), mergeDuplicate);
    gate.release();
    await walking;
    const ids = [old!.id, added.message.id].sort();
    expect((await sideRows(name))[`side:media:media:${a}`]?.map((e) => e.id).sort()).toEqual(ids);
    expect((await repo.media(a, 'media', { limit: 10 })).map((m) => m.id).sort()).toEqual(ids);
  });
});

describe('indexed queries and edge cases', () => {
  it('pages with before and limit exactly like a scan, and limits pins', async () => {
    const repo = await open();
    await buildAll(repo);
    const msgs: Message[] = [];
    for (let i = 1; i <= 9; i++) {
      msgs.push(withFile({ conversationId: a, sentAt: i, pinned: i % 2 === 1 }));
    }
    await repo.upsertMany(msgs, merge);
    const all = (await expected(repo, a)).media.media!;
    const page1 = await repo.media(a, 'media', { limit: 4 });
    expect(page1.map((m) => m.id)).toEqual(all.slice(0, 4));
    const page2 = await repo.media(a, 'media', { limit: 4, before: page1.at(-1)!.seq! });
    expect(page2.map((m) => m.id)).toEqual(all.slice(4, 8));
    const pins = (await expected(repo, a)).pinned;
    expect((await repo.pinned(a, 2)).map((m) => m.id)).toEqual(pins.slice(0, 2));
  });

  it('folds duplicate ids in one batch into the index like the scan sees them', async () => {
    const name = nextName();
    const repo = await open(name);
    await buildAll(repo);
    const first = withFile({ conversationId: a, sentAt: 1, pinned: true });
    await repo.upsertMany(
      [
        first,
        { ...first, pinned: false },
        withFile({ conversationId: a, sentAt: 2, pinned: true }),
      ],
      merge,
    );
    expect(await actual(repo, a)).toEqual(await expected(repo, a));
    const stored = (await sideRows(name))[`side:pinned:${a}`] ?? [];
    expect(stored.map((e) => e.id).sort()).toEqual([...(await expected(repo, a)).pinned].sort());
  });

  it('reads a corrupt side row as not built, and writes still succeed', async () => {
    const name = nextName();
    const repo = await open(name);
    await buildAll(repo);
    const m = (
      await repo.upsert(withFile({ conversationId: a, sentAt: 1, pinned: true }), mergeDuplicate)
    ).message;
    const raw = await openDB(name);
    await raw.put('sideIndex', { id: `side:pinned:${a}`, payload: new Uint8Array([1, 2, 3]) });
    raw.close();
    expect((await repo.pinned(a, 10)).map((x) => x.id)).toEqual([m.id]);
    const n = (
      await repo.upsert(withFile({ conversationId: a, sentAt: 2, pinned: true }), mergeDuplicate)
    ).message;
    expect((await repo.pinned(a, 10)).map((x) => x.id)).toEqual([n.id, m.id]);
    expect((await sideRows(name))[`side:pinned:${a}`]?.map((e) => e.id).sort()).toEqual(
      [m.id, n.id].sort(),
    );
  });
});

describe('cost and failure of maintenance', () => {
  it('a write that leaves membership alone reads no side row', async () => {
    const { cipher, probe } = probeCipher();
    const repo = await open(nextName(), cipher);
    const [m] = await repo.upsertMany(
      [withFile({ conversationId: a, sentAt: 1, pinned: true })],
      merge,
    );
    await buildAll(repo);
    probe.sideDecrypts = 0;
    await repo.update(m!.id, (x) => ({ ...x, body: 'a reaction or a receipt' }));
    await repo.upsert({ ...m!, body: 'edited' }, mergeDuplicate);
    expect(probe.sideDecrypts).toBe(0);
  });

  it('a failing side index never fails the save, and is rebuilt afterwards', async () => {
    const { cipher, probe } = probeCipher();
    const name = nextName();
    const repo = await open(name, cipher);
    await buildAll(repo);
    expect(Object.keys(await sideRows(name))).toContain(`side:pinned:${a}`);
    probe.failSideEncrypt = true;
    const saved = await repo.upsert(
      withFile({ conversationId: a, sentAt: 1, pinned: true }),
      mergeDuplicate,
    );
    expect((await repo.get(saved.message.id))?.pinned).toBe(true);
    const rows = await sideRows(name);
    expect(rows[`side:pinned:${a}`]).toBeUndefined();
    expect(rows[`side:media:media:${a}`]).toBeUndefined();
    probe.failSideEncrypt = false;
    expect((await repo.pinned(a, 5)).map((x) => x.id)).toEqual([saved.message.id]);
    expect((await sideRows(name))[`side:pinned:${a}`]).toHaveLength(1);
  });
});
