/**
 * What the pure normaliser needs from, and gives back to, the backend.
 *
 * The normaliser never performs I/O: anything that needs the daemon (a group
 * changed → re-list it; contacts synced → re-list them) is returned as an
 * *intent* event that `SignalCliBackend` acts on. That keeps every envelope →
 * event mapping testable with plain fixtures.
 */
import type { ConversationId } from '@/core/domain';
import type { BackendEvents } from '../../types';

export interface NormaliseContext {
  /** Our canonical id (ACI when known, else number). */
  selfId: string;
  /** Every identifier that means "us" (ACI, number) — mapped to `selfId`. */
  selfAliases: ReadonlySet<string>;
  /**
   * Maps a peer's number or ACI to whichever form is canonical for them
   * (DirectPeers), so a DM doesn't fork when the daemon starts addressing
   * someone by their other identifier. Identity on `id` not found as an
   * alias of anyone.
   */
  resolvePeer(id: string): string;
  /** Local receive time (epoch ms). */
  now: number;
  /** Display name for system texts, when known. */
  nameOf(id: string): string | undefined;
  /** Debug sink for skipped/unsupported content. */
  debug(message: string, detail?: unknown): void;
}

type DomainEvent = {
  [E in Exclude<keyof BackendEvents, 'status' | 'conversationUpdated' | 'contactUpdated'>]: {
    kind: E;
    payload: BackendEvents[E];
  };
}[Exclude<keyof BackendEvents, 'status' | 'conversationUpdated' | 'contactUpdated'>];

export type AdapterEvent =
  | DomainEvent
  /** The disappearing timer of a conversation changed (patch cached conversation). */
  | { kind: 'expirationChanged'; conversationId: ConversationId; seconds: number }
  /** A group update arrived: re-list it, diff, emit conversationUpdated + system text. */
  | {
      kind: 'groupChanged';
      groupId: string;
      conversationId: ConversationId;
      actorId: string;
      sentAt: number;
    }
  /** Contacts or block list were synced from the primary device. */
  | { kind: 'contactsChanged' };
