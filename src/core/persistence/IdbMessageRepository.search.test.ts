/**
 * The encrypted store's search works in slices so a large history never
 * blocks the UI: it yields between slices, streams matches, stops at its
 * limit and can be abandoned mid-scan.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mergeDuplicate, type Message } from '@/core/domain';
import { conversationIdFor, makeMessage } from '@/core/domain/testing';
import * as lib from '@/core/lib';
import { webCryptoCipher } from './crypto';
import { IdbMessageRepository } from './IdbMessageRepository';

let counter = 0;
let repo: IdbMessageRepository | undefined;

afterEach(() => {
  repo?.close();
  repo = undefined;
  vi.restoreAllMocks();
});

async function seeded(count: number, needleEvery: number): Promise<IdbMessageRepository> {
  const opened = await IdbMessageRepository.open(
    `snowdrop-search-${++counter}`,
    await webCryptoCipher(crypto.getRandomValues(new Uint8Array(32))),
  );
  repo = opened;
  const batch: Message[] = [];
  for (let i = 0; i < count; i++) {
    const { seq: _seq, ...m } = makeMessage({
      conversationId: conversationIdFor(`c${i % 4}`),
      authorId: 'z',
      sentAt: 1000 + i,
      body: i % needleEvery === 0 ? `needle ${i}` : `filler ${i}`,
    });
    batch.push(m);
  }
  await opened.upsertMany(batch, { backfill: false, merge: mergeDuplicate });
  return opened;
}

describe('IdbMessageRepository.search (sliced scan)', () => {
  it('yields to the event loop between slices of a long scan', async () => {
    const r = await seeded(1500, 10_000);
    const yielded = vi.spyOn(lib, 'yieldToEventLoop');
    expect(await r.search('absent', { limit: 10 })).toEqual([]);
    expect(yielded.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('streams matches as slices finish, newest first, and stops at the limit', async () => {
    const r = await seeded(1500, 600);
    const yielded = vi.spyOn(lib, 'yieldToEventLoop');
    const partials: string[][] = [];
    const final = await r.search('needle', {
      limit: 2,
      onPartial: (found) => partials.push(found.map((m) => m.body)),
    });
    expect(final.map((m) => m.body)).toEqual(['needle 1200', 'needle 600']);
    // The newest match sits in the first slice: reported before the scan ends.
    expect(partials[0]).toEqual(['needle 1200']);
    // The limit ended the scan in the second slice, so it never reached the third.
    expect(yielded.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('abandons a scan whose signal is aborted between slices', async () => {
    const r = await seeded(1500, 10_000);
    const controller = new AbortController();
    const yielded = vi.spyOn(lib, 'yieldToEventLoop').mockImplementation(() => {
      controller.abort();
      return Promise.resolve();
    });
    await expect(
      r.search('absent', { limit: 10, signal: controller.signal }),
    ).rejects.toBeDefined();
    expect(yielded).toHaveBeenCalledTimes(1);
  });

  it('keeps ordering across a conversation-scoped scan', async () => {
    const r = await seeded(1500, 300);
    const found = await r.search('needle', { conversationId: conversationIdFor('c0'), limit: 10 });
    // i % 4 === 0 and i % 300 === 0: every 300th.
    expect(found.map((m) => m.body)).toEqual([
      'needle 1200',
      'needle 900',
      'needle 600',
      'needle 300',
      'needle 0',
    ]);
  });
});
