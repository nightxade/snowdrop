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
import { ignore } from '@/core/lib';
import type { KeyValueStorage } from '@/core/persistence';
import { isUuid } from './identity';
import { peersStorageKey } from './storageKeys';
import { isRecord } from './validate';

interface StoredShape {
  peers: Record<string, number>;
  aliases: Record<string, string>;
  /** Numbers that moved to another ACI while a conversation is still keyed by them. */
  moved?: string[];
}

export class DirectPeers {
  private peers = new Map<string, number>();
  /** Every known alias (number or ACI) → the canonical id chosen for it. */
  private aliases = new Map<string, string>();
  /**
   * Numbers that now belong to someone else while the old holder's conversation
   * is still keyed by them: that conversation is addressed by the holder's ACI
   * (as Desktop does), never by the number.
   */
  private moved = new Set<string>();
  private readonly key: string;

  constructor(
    private readonly storage: KeyValueStorage | undefined,
    account: string,
  ) {
    this.key = peersStorageKey(account);
    this.load();
  }

  /** peerId → last activity (epoch ms), canonical ids only. */
  entries(): [string, number][] {
    return [...this.peers.entries()];
  }

  has(peerId: string): boolean {
    return this.peers.has(this.resolve(peerId));
  }

  /**
   * Where a message for the DM keyed `id` goes. Normally the id itself; for a
   * conversation keyed by a recycled number, the old holder's ACI. Undefined
   * when that holder isn't known, so nothing can reach the number's new owner.
   */
  addressFor(id: string): string | undefined {
    if (!this.moved.has(id)) return id;
    for (const [alias, target] of this.aliases) {
      if (target === id && isUuid(alias)) return alias;
    }
    return undefined;
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
   * If both forms already have activity (a DM that forked before the pair
   * was known), the more recently active one becomes canonical and the other
   * entry is folded into it, so only one conversation stays listed and
   * writable. Messages stored under the folded id stay in storage but aren't
   * listed: merging them would mean rewriting their ids, authors, quotes and
   * reactions, and a writable second thread would route replies wrongly.
   *
   * The ACI is the identity and a number is only an alias for it (as in
   * Signal Desktop), so a number that now pairs with a different ACI has
   * moved: it never folds two ACIs into one conversation. The old holder
   * keeps its conversation, and the number follows the new ACI.
   */
  learnPair(uuid: string | undefined, number: string | undefined): void {
    if (!uuid || !number || uuid === number) return;
    let changed = false;
    if (this.numberMovedTo(uuid, number)) {
      // When the old holder's conversation is keyed by this very number, that
      // key has to stay with it; the new ACI simply keeps its own.
      if (this.aliases.get(number) === number) {
        if (this.aliases.get(uuid) === undefined) this.aliases.set(uuid, uuid);
        this.moved.add(number);
        this.save();
        return;
      }
      this.aliases.delete(number);
      changed = true;
    }
    // The number is back with (or newly paired to) whoever its conversation is for.
    if (this.moved.delete(number)) changed = true;
    const existing = this.aliases.get(uuid) ?? this.aliases.get(number);
    const canonical = existing ?? this.pickCanonical(uuid, number);
    if (this.aliases.get(uuid) === canonical && this.aliases.get(number) === canonical) {
      if (changed) this.save();
      return;
    }
    this.aliases.set(uuid, canonical);
    this.aliases.set(number, canonical);
    const other = canonical === uuid ? number : uuid;
    const otherAt = this.peers.get(other);
    if (otherAt !== undefined) {
      this.peers.delete(other);
      this.peers.set(canonical, Math.max(otherAt, this.peers.get(canonical) ?? -Infinity));
    }
    this.save();
  }

  /** Whether `number` is currently bound to an ACI other than `uuid`. */
  private numberMovedTo(uuid: string, number: string): boolean {
    const canonical = this.aliases.get(number);
    if (canonical === undefined) return false;
    const holds = (id: string): boolean => isUuid(id);
    if (holds(canonical)) return canonical !== uuid && this.aliases.get(uuid) !== canonical;
    // The conversation is keyed by a number: look for the ACI bound to it.
    for (const [alias, target] of this.aliases) {
      if (target === canonical && holds(alias) && alias !== uuid) return true;
    }
    return false;
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
      if (Array.isArray(parsed.moved)) {
        for (const id of parsed.moved) if (typeof id === 'string') this.moved.add(id);
      }
    } catch (error) {
      ignore(error, 'corrupt entry: start empty; conversations reappear as messages arrive');
    }
  }

  private save(): void {
    try {
      const shape: StoredShape = {
        peers: Object.fromEntries(this.peers),
        aliases: Object.fromEntries(this.aliases),
        ...(this.moved.size > 0 ? { moved: [...this.moved] } : {}),
      };
      this.storage?.setItem(this.key, JSON.stringify(shape));
    } catch (error) {
      ignore(error, 'quota/disabled storage: keep the in-memory set');
    }
  }
}
