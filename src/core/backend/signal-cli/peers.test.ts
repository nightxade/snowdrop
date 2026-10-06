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
});
