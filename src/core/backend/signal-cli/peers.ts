/**
 * Which 1:1 conversations exist.
 *
 * signal-cli has no conversation list: groups can be listed, but a "DM" is
 * just any contact we've exchanged messages with. Listing every contact
 * would flood the sidebar with the phone's whole address book, so we remember
 * the peers we've actually seen messages with (in either direction), per
 * account, in small local storage.
 *
 * A peer's number and ACI both identify the same person, and which one an
 * envelope carries can change (a contact re-registers, a sync finally learns
 * their ACI, …). Without tracking that, the same person's DM forks into two
 * conversations the moment the daemon starts addressing them differently.
 * `learnPair` records the alias whenever both halves are seen together, and
 * `resolve` maps either one to a single canonical id — whichever form
 * already has activity recorded (so existing history doesn't need migrating),
 * falling back to the ACI.
 */
import type { KeyValueStorage } from '@/core/persistence';
import { isRecord } from './validate';

interface StoredShape {
  peers: Record<string, number>;
  aliases: Record<string, string>;
}

export class DirectPeers {
  private peers = new Map<string, number>();
  /** Every known alias (number or ACI) → the canonical id chosen for it. */
  private aliases = new Map<string, string>();
  private readonly key: string;

  constructor(
    private readonly storage: KeyValueStorage | undefined,
    account: string,
  ) {
    this.key = `snowdrop.signal-cli.peers.${account}`;
    this.load();
  }

  /** peerId → last activity (epoch ms). A pre-alias fork keeps both ids (see learnPair). */
  entries(): [string, number][] {
    return [...this.peers.entries()];
  }

  has(peerId: string): boolean {
    return this.peers.has(this.resolve(peerId));
  }

  /** Maps any known alias of a peer (number or ACI) to its canonical id. */
  resolve(id: string): string {
    return this.aliases.get(id) ?? id;
  }

  /**
   * A number/uuid pair seen together for the same peer (an envelope, a
   * contact listing, a sync transcript). Picks whichever form already has
   * activity recorded as canonical — so no message needs to move — and
   * otherwise prefers the ACI, same as `addressId`.
   *
   * If both forms already have activity (a DM that forked before aliases
   * were tracked), new traffic goes to the more recently active one, and the
   * other keeps its own entry: its messages are stored under its own
   * conversation id, so dropping the entry would hide that history.
   */
  learnPair(uuid: string | undefined, number: string | undefined): void {
    if (!uuid || !number || uuid === number) return;
    const existing = this.aliases.get(uuid) ?? this.aliases.get(number);
    const canonical = existing ?? this.pickCanonical(uuid, number);
    if (this.aliases.get(uuid) === canonical && this.aliases.get(number) === canonical) return;
    this.aliases.set(uuid, canonical);
    this.aliases.set(number, canonical);
    this.save();
  }

  private pickCanonical(uuid: string, number: string): string {
    const uuidAt = this.peers.get(uuid);
    const numberAt = this.peers.get(number);
    if (numberAt === undefined) return uuid;
    if (uuidAt === undefined) return number;
    return numberAt > uuidAt ? number : uuid;
  }

  /** Records activity; returns true when the peer is new. */
  touch(peerId: string, at: number): boolean {
    const id = this.resolve(peerId);
    const prev = this.peers.get(id);
    if (prev !== undefined && prev >= at) return false;
    this.peers.set(id, at);
    this.save();
    return prev === undefined;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(this.key);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) return;
      // Pre-alias storage was just the flat peers map; the current shape
      // nests it alongside the alias map.
      const peersObj = isRecord(parsed.peers) ? parsed.peers : parsed;
      for (const [id, at] of Object.entries(peersObj)) {
        if (typeof at === 'number' && Number.isFinite(at)) this.peers.set(id, at);
      }
      if (isRecord(parsed.aliases)) {
        for (const [id, canonical] of Object.entries(parsed.aliases)) {
          if (typeof canonical === 'string') this.aliases.set(id, canonical);
        }
      }
    } catch {
      // Corrupt entry: start empty; conversations reappear as messages arrive.
    }
  }

  private save(): void {
    try {
      const shape: StoredShape = {
        peers: Object.fromEntries(this.peers),
        aliases: Object.fromEntries(this.aliases),
      };
      this.storage?.setItem(this.key, JSON.stringify(shape));
    } catch {
      // Quota/disabled storage: keep the in-memory set.
    }
  }
}
