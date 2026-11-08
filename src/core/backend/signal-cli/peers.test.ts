/**
 * DirectPeers: the DM list, and the number↔ACI alias map that keeps a peer's
 * conversation from forking when the daemon starts addressing them by their
 * other identifier.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/core/persistence';
import { DirectPeers } from './peers';

const ACCOUNT = 'self-1';

describe('DirectPeers aliasing', () => {
  it('(regression) resolves a peer by either number or ACI to the same, pre-existing conversation', () => {
    const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);

    // The DM started life addressed by number — it has history there.
    peers.touch('+15551234567', 1_000);
    expect(peers.entries()).toEqual([['+15551234567', 1_000]]);

    // The daemon learns their ACI (e.g. from an envelope carrying both) and
    // later addresses the same person by ACI alone.
    peers.learnPair('aci-abc', '+15551234567');
    expect(peers.resolve('aci-abc')).toBe('+15551234567');
    expect(peers.resolve('+15551234567')).toBe('+15551234567');

    // A later message addressed only by ACI still lands on the existing
    // conversation — no fork, no migration.
    peers.touch('aci-abc', 2_000);
    expect(peers.entries()).toEqual([['+15551234567', 2_000]]);
    expect(peers.has('aci-abc')).toBe(true);
  });

  it('prefers the ACI when neither form has history yet', () => {
    const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
    peers.learnPair('aci-xyz', '+15559876543');
    expect(peers.resolve('+15559876543')).toBe('aci-xyz');
    expect(peers.resolve('aci-xyz')).toBe('aci-xyz');
  });

  it('persists the alias map alongside the peer list, across instances', () => {
    const storage = createMemoryStorage();
    const first = new DirectPeers(storage, ACCOUNT);
    first.touch('+15551112222', 1);
    first.learnPair('aci-persisted', '+15551112222');

    const second = new DirectPeers(storage, ACCOUNT);
    expect(second.resolve('aci-persisted')).toBe('+15551112222');
    expect(second.has('aci-persisted')).toBe(true);
  });

  it('loads a pre-alias (flat) storage shape without errors', () => {
    const storage = createMemoryStorage({
      [`snowdrop.signal-cli.peers.${ACCOUNT}`]: JSON.stringify({ '+15550000000': 5 }),
    });
    const peers = new DirectPeers(storage, ACCOUNT);
    expect(peers.entries()).toEqual([['+15550000000', 5]]);
  });

  it('(regression) an already-forked DM folds into the more recent side, leaving one writable conversation', () => {
    const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
    peers.touch('+15550001', 100);
    peers.touch('aci-1', 50);

    peers.learnPair('aci-1', '+15550001');

    // New traffic folds to the more recently active form, not blindly the ACI...
    expect(peers.resolve('aci-1')).toBe('+15550001');
    expect(peers.resolve('+15550001')).toBe('+15550001');
    // ...and the older fork is folded away, so replies can't land in a dead thread.
    expect(peers.entries()).toEqual([['+15550001', 100]]);
  });

  describe('a recycled phone number', () => {
    const A = '11111111-1111-4111-8111-111111111111';
    const B = '22222222-2222-4222-8222-222222222222';
    const N = '+15550009';

    it('never folds a second ACI into the first holder of the number', () => {
      const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
      peers.learnPair(A, N);
      peers.touch(A, 10);
      expect(peers.resolve(N)).toBe(A);

      peers.learnPair(B, N);
      expect(peers.resolve(B)).toBe(B);
      expect(peers.resolve(A)).toBe(A);
      // The number follows its new holder.
      expect(peers.resolve(N)).toBe(B);
      peers.touch(B, 20);
      expect(new Map(peers.entries())).toEqual(
        new Map([
          [A, 10],
          [B, 20],
        ]),
      );
    });

    it('keeps the first holder separate when their conversation is keyed by the number', () => {
      const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
      peers.touch(N, 5);
      peers.learnPair(A, N);
      expect(peers.resolve(A)).toBe(N);

      peers.learnPair(B, N);
      expect(peers.resolve(B)).toBe(B);
      expect(peers.resolve(A)).toBe(N);
      peers.touch(B, 9);
      expect(new Map(peers.entries())).toEqual(
        new Map([
          [N, 5],
          [B, 9],
        ]),
      );
    });

    it('is stable when the same pair is seen again, and survives a reload', () => {
      const storage = createMemoryStorage();
      const peers = new DirectPeers(storage, ACCOUNT);
      peers.learnPair(A, N);
      peers.learnPair(B, N);
      peers.learnPair(A, N);
      peers.learnPair(B, N);
      const reloaded = new DirectPeers(storage, ACCOUNT);
      expect(reloaded.resolve(B)).toBe(B);
      expect(reloaded.resolve(A)).toBe(A);
    });

    it('addresses a chat keyed by the moved number through its old holder, and persists that', () => {
      const storage = createMemoryStorage();
      const peers = new DirectPeers(storage, ACCOUNT);
      peers.touch(N, 5);
      peers.learnPair(A, N);
      expect(peers.addressFor(N)).toBe(N); // nothing has moved yet
      peers.learnPair(B, N);
      expect(peers.addressFor(N)).toBe(A);
      expect(peers.addressFor(B)).toBe(B);
      expect(new DirectPeers(storage, ACCOUNT).addressFor(N)).toBe(A);
      // The number coming back to its first holder lifts the redirect.
      peers.learnPair(A, N);
      expect(peers.addressFor(N)).toBe(N);
    });

    it('alternating stale pairs never merge two ACIs; the newest pair decides the holder', () => {
      const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
      peers.learnPair(A, N);
      for (let i = 0; i < 3; i += 1) {
        peers.learnPair(B, N);
        expect(peers.resolve(N)).toBe(B);
        peers.learnPair(A, N);
        expect(peers.resolve(N)).toBe(A);
      }
      peers.learnPair(B, N);
      expect(peers.resolve(N)).toBe(B);
      expect(peers.resolve(A)).toBe(A);
      expect(peers.resolve(B)).toBe(B);
    });

    it('alternating pairs on a number-keyed chat keep the redirect consistent with the newest pair', () => {
      const peers = new DirectPeers(createMemoryStorage(), ACCOUNT);
      peers.touch(N, 5);
      peers.learnPair(A, N);
      peers.learnPair(B, N);
      peers.learnPair(A, N);
      expect(peers.addressFor(N)).toBe(N);
      peers.learnPair(B, N);
      expect(peers.addressFor(N)).toBe(A);
      expect(peers.resolve(A)).toBe(N);
      expect(peers.resolve(B)).toBe(B);
    });
  });
});
