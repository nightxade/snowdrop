/**
 * The gallery query: which messages each tab finds, newest first, paged by
 * `before`, and (for the encrypted store) scanned in slices that yield and
 * can be abandoned.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeDuplicate, type Attachment, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import * as lib from '@/core/lib';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';
import { MemoryMessageRepository } from './MemoryMessageRepository';
import type { MessageRepository } from './MessageRepository';

const a = conversationIdFor('a');
const b = conversationIdFor('b');

const att = (id: string, contentType: string): Attachment => ({ id, contentType });

/** Messages as a backend delivers them: no seq yet. */
const incoming = (partial: Partial<Message>): Message => {
  const { seq: _seq, ...m } = makeMessage(partial);
  return m;
};

let counter = 0;
type Repo = MessageRepository & { close?: () => void };
const implementations: [string, () => Promise<Repo>][] = [
  ['memory', () => Promise.resolve(new MemoryMessageRepository())],
  [
    'indexeddb+webCryptoCipher',
    async () =>
      IdbMessageRepository.open(
        `snowdrop-media-${++counter}`,
        await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32))),
      ),
  ],
];

const open: Repo[] = [];
afterEach(() => {
  for (const repo of open.splice(0)) repo.close?.();
  vi.restoreAllMocks();
});

describe.each(implementations)('MessageRepository.media (%s)', (_name, create) => {
  async function seeded(): Promise<Repo> {
    const repo = await create();
    open.push(repo);
    await repo.upsertMany(
      [
        incoming({ conversationId: a, sentAt: 1, body: 'plain' }),
        incoming({ conversationId: a, sentAt: 2, attachments: [att('p1', 'image/png')] }),
        incoming({ conversationId: a, sentAt: 3, attachments: [att('v1', 'video/mp4')] }),
        incoming({ conversationId: a, sentAt: 4, attachments: [att('au1', 'audio/mpeg')] }),
        incoming({
          conversationId: a,
          sentAt: 5,
          attachments: [att('d1', 'application/pdf'), att('p2', 'image/jpeg')],
        }),
        incoming({
          conversationId: a,
          sentAt: 6,
          body: 'see https://example.com',
          previews: [{ url: 'https://example.com', title: 'Example' }],
        }),
        incoming({
          conversationId: a,
          sentAt: 7,
          previews: [{ url: 'javascript:alert(1)', title: 'Bad' }],
        }),
        incoming({
          conversationId: a,
          sentAt: 8,
          attachments: [att('gone', 'image/png')],
          deleted: true,
        }),
        incoming({
          conversationId: a,
          sentAt: 9,
          attachments: [att('sys', 'image/png')],
          kind: 'system',
        }),
        incoming({ conversationId: b, sentAt: 10, attachments: [att('other', 'image/png')] }),
      ],
      { backfill: false, merge: mergeDuplicate },
    );
    return repo;
  }
  const sentAts = (messages: Message[]) => messages.map((m) => m.sentAt);

  it('sorts a conversation into its tabs, newest first', async () => {
    const repo = await seeded();
    expect(sentAts(await repo.media(a, 'media', { limit: 50 }))).toEqual([5, 3, 2]);
    expect(sentAts(await repo.media(a, 'audio', { limit: 50 }))).toEqual([4]);
    expect(sentAts(await repo.media(a, 'files', { limit: 50 }))).toEqual([5]);
    expect(sentAts(await repo.media(a, 'links', { limit: 50 }))).toEqual([6]);
  });

  it('leaves out deleted messages, system lines, other conversations and non-web links', async () => {
    const repo = await seeded();
    const everything = await Promise.all(
      (['media', 'audio', 'files', 'links'] as const).map((kind) =>
        repo.media(a, kind, { limit: 50 }),
      ),
    );
    const ids = everything.flat().map((m) => m.attachments.map((x) => x.id));
    expect(ids.flat()).not.toContain('gone');
    expect(ids.flat()).not.toContain('sys');
    expect(ids.flat()).not.toContain('other');
    expect(sentAts(everything[3] ?? [])).not.toContain(7);
  });

  it('pages with `before` and stops when the history runs out', async () => {
    const repo = await seeded();
    const first = await repo.media(a, 'media', { limit: 2 });
    expect(sentAts(first)).toEqual([5, 3]);
    const second = await repo.media(a, 'media', { limit: 2, before: first.at(-1)?.seq as number });
    expect(sentAts(second)).toEqual([2]);
    const third = await repo.media(a, 'media', { limit: 2, before: second.at(-1)?.seq as number });
    expect(third).toEqual([]);
  });

  it('returns nothing for a zero limit and rejects an already-aborted call', async () => {
    const repo = await seeded();
    expect(await repo.media(a, 'media', { limit: 0 })).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    await expect(repo.media(a, 'media', { limit: 5, signal: controller.signal })).rejects.toThrow();
  });
});

describe('IdbMessageRepository.media (sliced scan)', () => {
  async function bulk(count: number, everyN: number): Promise<IdbMessageRepository> {
    const repo = await IdbMessageRepository.open(
      `snowdrop-media-bulk-${++counter}`,
      await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32))),
    );
    open.push(repo);
    const batch: Message[] = [];
    for (let i = 0; i < count; i++) {
      batch.push(
        incoming({
          conversationId: i % 2 === 0 ? a : b,
          authorId: 'z',
          sentAt: 1000 + i,
          attachments: i % everyN === 0 ? [att(`m${i}`, 'image/png')] : [],
        }),
      );
    }
    await repo.upsertMany(batch, { backfill: false, merge: mergeDuplicate });
    return repo;
  }

  it('yields between slices of a long scan and finds a match past the first slice', async () => {
    const repo = await bulk(2000, 1000);
    const yielded = vi.spyOn(lib, 'yieldToEventLoop');
    const found = await repo.media(a, 'media', { limit: 5 });
    // Conversation `a` holds the even sentAts; matches are 1000+0 and 1000+1000.
    expect(found.map((m) => m.sentAt)).toEqual([2000, 1000]);
    expect(yielded.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('stops early at the limit without reading the rest', async () => {
    const repo = await bulk(2000, 2);
    const yielded = vi.spyOn(lib, 'yieldToEventLoop');
    const found = await repo.media(a, 'media', { limit: 3 });
    expect(found).toHaveLength(3);
    expect(yielded).not.toHaveBeenCalled();
  });

  it('abandons a scan whose signal is aborted between slices', async () => {
    const repo = await bulk(2000, 100_000);
    const controller = new AbortController();
    const yielded = vi.spyOn(lib, 'yieldToEventLoop').mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(repo.media(a, 'media', { limit: 5, signal: controller.signal })).rejects.toThrow();
    expect(yielded).toHaveBeenCalledTimes(1);
  });
});
