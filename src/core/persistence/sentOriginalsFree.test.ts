import 'fake-indexeddb/auto';
import { openDB } from 'idb';
import { describe, expect, it } from 'vitest';
import { mergeOutgoingCommit, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';
import { MemoryMessageRepository } from './MemoryMessageRepository';
import type { MessageRepository } from './MessageRepository';

const a = conversationIdFor('a');
const b = conversationIdFor('b');
const BYTES = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 11, 12, 13, 14, 15, 16]);
const OLD = 10;
const NEW = 1000;
const CUTOFF = 500;

let counter = 0;
const key = () => crypto.getRandomValues(new Uint8Array(32));
const implementations: [string, () => Promise<MessageRepository>][] = [
  ['memory', () => Promise.resolve(new MemoryMessageRepository())],
  ['indexeddb', () => IdbMessageRepository.open(`snowdrop-free-${++counter}`)],
  [
    'indexeddb+webCryptoCipher',
    async () =>
      IdbMessageRepository.open(`snowdrop-free-${++counter}`, await webCryptoCipher(key())),
  ],
];

const image = (id: string) => ({ id, contentType: 'image/png', original: true });

const sent = (conversationId: typeof a, sentAt: number, ...ids: string[]): Message =>
  makeMessage({
    conversationId,
    authorId: 'me',
    sentAt,
    status: 'sent',
    attachments: ids.map(image),
  });

async function commit(repo: MessageRepository, message: Message) {
  await repo.commitOutgoing(
    'n',
    message,
    mergeOutgoingCommit,
    message.attachments.map((x) => ({ id: x.id, data: new Blob([BYTES]) })),
  );
}

const hasOriginal = async (repo: MessageRepository, id: string) =>
  (await repo.readSentMedia(id, 'image/png')) !== undefined;

describe.each(implementations)('sent originals usage (%s)', (_name, create) => {
  it('is nothing when none are kept', async () => {
    const repo = await create();
    expect(await repo.sentOriginalsUsage()).toEqual({ photos: 0, bytes: 0 });
  });

  it('sums every kept original, across conversations', async () => {
    const repo = await create();
    await commit(repo, sent(a, OLD, 'local:1', 'local:2'));
    await commit(repo, sent(b, NEW, 'local:3'));
    const usage = await repo.sentOriginalsUsage();
    expect(usage.photos).toBe(3);
    // Encrypted copies are a little larger than the bytes they hold.
    expect(usage.bytes).toBeGreaterThanOrEqual(3 * BYTES.length);
  });

  it('covers only messages sent before the cutoff when given one', async () => {
    const repo = await create();
    await commit(repo, sent(a, OLD, 'local:1', 'local:2'));
    await commit(repo, sent(b, NEW, 'local:3'));
    const all = await repo.sentOriginalsUsage();
    const older = await repo.sentOriginalsUsage({ olderThan: CUTOFF });
    expect(older.photos).toBe(2);
    expect(older.bytes).toBeLessThan(all.bytes);
    expect(older.bytes).toBeGreaterThanOrEqual(2 * BYTES.length);
    expect(await repo.sentOriginalsUsage({ olderThan: Infinity })).toEqual(all);
    expect(await repo.sentOriginalsUsage({ olderThan: 1 })).toEqual({ photos: 0, bytes: 0 });
  });

  it('reports progress and stops when the signal aborts', async () => {
    const repo = await create();
    await commit(repo, sent(a, OLD, 'local:1'));
    const progress: [number, number][] = [];
    const scope = {
      olderThan: CUTOFF,
      onProgress: (d: number, t: number) => progress.push([d, t]),
    };
    await repo.sentOriginalsUsage(scope);
    if (repo instanceof IdbMessageRepository) expect(progress.at(-1)).toEqual([1, 1]);
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(repo.sentOriginalsUsage({ ...scope, signal: controller.signal })).rejects.toThrow(
      'stop',
    );
  });
});

describe.each(implementations)('dropping sent originals by age (%s)', (_name, create) => {
  it('removes older originals and clears their flags, in every conversation', async () => {
    const repo = await create();
    const oldA = sent(a, OLD, 'local:1');
    const oldB = sent(b, OLD + 1, 'local:2');
    await commit(repo, oldA);
    await commit(repo, oldB);
    const before = await repo.sentOriginalsUsage();
    const dropped = await repo.dropSentOriginals({ olderThan: CUTOFF });
    expect(dropped.photos).toBe(2);
    expect(dropped.bytes).toBe(before.bytes);
    expect(dropped.attachmentIds.toSorted()).toEqual(['local:1', 'local:2']);
    expect(await hasOriginal(repo, 'local:1')).toBe(false);
    expect(await hasOriginal(repo, 'local:2')).toBe(false);
    for (const m of [oldA, oldB]) {
      const stored = await repo.get(m.id);
      expect(stored?.attachments).toHaveLength(1);
      expect(stored?.attachments[0]?.original).toBeUndefined();
      expect(stored?.attachments[0]?.contentType).toBe('image/png');
    }
    expect(await repo.sentOriginalsUsage()).toEqual({ photos: 0, bytes: 0 });
  });

  it('keeps newer originals and their flags', async () => {
    const repo = await create();
    const old = sent(a, OLD, 'local:1');
    const fresh = sent(a, NEW, 'local:2');
    const otherFresh = sent(b, NEW + 1, 'local:3');
    await commit(repo, old);
    await commit(repo, fresh);
    await commit(repo, otherFresh);
    const dropped = await repo.dropSentOriginals({ olderThan: CUTOFF });
    expect(dropped.attachmentIds).toEqual(['local:1']);
    expect(await hasOriginal(repo, 'local:2')).toBe(true);
    expect(await hasOriginal(repo, 'local:3')).toBe(true);
    expect((await repo.get(fresh.id))?.attachments[0]?.original).toBe(true);
    expect((await repo.get(otherFresh.id))?.attachments[0]?.original).toBe(true);
    expect((await repo.sentOriginalsUsage()).photos).toBe(2);
  });

  it("drops all of a message's originals together, leaving the rest of it alone", async () => {
    const repo = await create();
    const message = {
      ...sent(a, OLD, 'local:1', 'local:2'),
      body: 'two photos',
      attachments: [
        image('local:1'),
        { id: 'local:file', contentType: 'text/plain' },
        image('local:2'),
      ],
    };
    await commit(repo, message);
    await repo.dropSentOriginals({ olderThan: CUTOFF });
    const stored = await repo.get(message.id);
    expect(stored?.body).toBe('two photos');
    expect(stored?.attachments.map((x) => x.id)).toEqual(['local:1', 'local:file', 'local:2']);
    expect(stored?.attachments.some((x) => x.original === true)).toBe(false);
    expect(await hasOriginal(repo, 'local:1')).toBe(false);
    expect(await hasOriginal(repo, 'local:2')).toBe(false);
  });

  it('covers every message with Infinity, and does nothing the second time', async () => {
    const repo = await create();
    await commit(repo, sent(a, OLD, 'local:1'));
    await commit(repo, sent(a, NEW, 'local:2'));
    expect((await repo.dropSentOriginals({ olderThan: Infinity })).photos).toBe(2);
    expect(await repo.dropSentOriginals({ olderThan: Infinity })).toEqual({
      photos: 0,
      bytes: 0,
      attachmentIds: [],
    });
  });

  it('leaves the message in its place in the timeline', async () => {
    const repo = await create();
    const first = sent(a, OLD, 'local:1');
    const second = sent(a, OLD + 1, 'local:2');
    await commit(repo, first);
    await commit(repo, second);
    const seqs = async () => (await repo.page(a, { limit: 10 })).map((m) => [m.id, m.seq]);
    const before = await seqs();
    await repo.dropSentOriginals({ olderThan: CUTOFF });
    expect(await seqs()).toEqual(before);
  });

  it('stops when the signal aborts, before removing anything', async () => {
    const repo = await create();
    await commit(repo, sent(a, OLD, 'local:1'));
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    await expect(
      repo.dropSentOriginals({ olderThan: CUTOFF, signal: controller.signal }),
    ).rejects.toThrow('stop');
    expect(await hasOriginal(repo, 'local:1')).toBe(true);
  });
});

describe('dropping sent originals at rest', () => {
  it('skips a message row it cannot read, and never deletes it or its original', async () => {
    const name = `snowdrop-free-${++counter}`;
    const repo = await IdbMessageRepository.open(name, await webCryptoCipher(key()));
    const broken = sent(a, OLD, 'local:1');
    const fine = sent(b, OLD + 1, 'local:2');
    await commit(repo, broken);
    await commit(repo, fine);
    const raw = await openDB(name);
    const rows = (await raw.getAll('messages')) as { id: string; payload: Uint8Array }[];
    const target = rows.find((r) => r.payload.length > 0) as { id: string; payload: Uint8Array };
    // Whichever row this is, tamper with one and learn which message it was afterwards.
    const tampered = new Uint8Array(target.payload);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
    await raw.put('messages', { ...(await raw.get('messages', target.id)), payload: tampered });
    const rowsBefore = await raw.count('messages');
    const mediaBefore = await raw.count('sentMedia');

    const dropped = await repo.dropSentOriginals({ olderThan: CUTOFF });

    expect(dropped.photos).toBe(1);
    expect(await raw.count('messages')).toBe(rowsBefore);
    expect(await raw.count('sentMedia')).toBe(mediaBefore - 1);
    const unreadable = (await raw.get('messages', target.id)) as { payload: Uint8Array };
    expect([...unreadable.payload]).toEqual([...tampered]);
    raw.close();
    // The measure skips it too.
    expect((await repo.sentOriginalsUsage({ olderThan: CUTOFF })).photos).toBe(0);
  });

  it('adds no plaintext fields to the stored rows', async () => {
    const name = `snowdrop-free-${++counter}`;
    const repo = await IdbMessageRepository.open(name, await webCryptoCipher(key()));
    await commit(repo, sent(a, OLD, 'local:1'));
    const raw = await openDB(name);
    const [media] = (await raw.getAll('sentMedia')) as Record<string, unknown>[];
    raw.close();
    expect(Object.keys(media ?? {}).toSorted()).toEqual(['conversationKey', 'id', 'payload']);
  });
});
