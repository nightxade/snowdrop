/**
 * Which 1:1 conversations exist.
 *
 * signal-cli has no conversation list: groups can be listed, but a "DM" is
 * just any contact we've exchanged messages with. Listing every contact
 * would flood the sidebar with the phone's whole address book, so we remember
 * the peers we've actually seen messages with (in either direction), per
 * account, in small local storage.
 */
import type { KeyValueStorage } from '@/core/persistence';
import { isRecord } from './validate';

export class DirectPeers {
  private peers = new Map<string, number>();
  private readonly key: string;

  constructor(
    private readonly storage: KeyValueStorage | undefined,
    account: string,
  ) {
    this.key = `shrike.signal-cli.peers.${account}`;
    this.load();
  }

  /** peerId → last activity (epoch ms). */
  entries(): [string, number][] {
    return [...this.peers.entries()];
  }

  has(peerId: string): boolean {
    return this.peers.has(peerId);
  }

  /** Records activity; returns true when the peer is new. */
  touch(peerId: string, at: number): boolean {
    const prev = this.peers.get(peerId);
    if (prev !== undefined && prev >= at) return false;
    this.peers.set(peerId, at);
    this.save();
    return prev === undefined;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return;
      for (const [id, at] of Object.entries(parsed)) {
        if (typeof at === 'number' && Number.isFinite(at)) this.peers.set(id, at);
      }
    } catch {
      // Corrupt entry: start empty; conversations reappear as messages arrive.
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(this.key, JSON.stringify(Object.fromEntries(this.peers)));
    } catch {
      // Quota/disabled storage: keep the in-memory set.
    }
  }
}
