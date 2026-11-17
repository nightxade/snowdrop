/**
 * The incoming-event pump of SignalCliBackend: decodes and enriches raw
 * stream events, applies them in order through one promise queue, and
 * emits the results (and resume checkpoints) through the backend's emitter.
 * The ordering contract is documented above `enqueue`.
 */
import { parseConversationId, type Conversation, type ConversationId } from '@/core/domain';
import { ignore, stripBidiControls, type Clock, type Emitter } from '@/core/lib';
import type { KeyValueStorage } from '@/core/lib';
import type { BackendEvents } from '../types';
import type { Directory } from './directory';
import { describeError } from './errors';
import { GroupChangeTracker } from './groupChanges';
import type { SelfIdentity } from './identity';
import { systemMessage } from './normalise/content';
import { describeGroupChange, toDirectConversation } from './normalise/directory';
import { normaliseReceive } from './normalise/envelope';
import type { AdapterEvent, NormaliseContext } from './normalise/types';
import type { DirectPeers } from './peers';
import type { TransportEvent } from './transport';
import { isRecord } from './validate';

const ATTACHMENT_BACKFILL_STATUSES = new Set(['pending', 'ready', 'failed']);

/**
 * Parses the `attachmentBackfill` SSE event's data (patches/signal-cli's
 * `{targetAuthor, targetTimestamp, status, attachmentIds}`) into the
 * `BackendEvents['attachmentBackfill']` shape. Lenient like `learnSelf`/
 * `learnPeers`: a malformed event is dropped rather than crashing the
 * stream, since it's advisory (the attachment just stays however it was).
 */
function parseAttachmentBackfillEvent(
  payload: unknown,
): BackendEvents['attachmentBackfill'] | undefined {
  if (!isRecord(payload)) return undefined;
  const { targetAuthor, targetTimestamp, status, attachmentIds } = payload;
  if (typeof targetAuthor !== 'string') return undefined;
  if (typeof targetTimestamp !== 'number' && typeof targetTimestamp !== 'string') return undefined;
  if (typeof status !== 'string' || !ATTACHMENT_BACKFILL_STATUSES.has(status)) return undefined;
  if (!Array.isArray(attachmentIds) || !attachmentIds.every((id) => typeof id === 'string'))
    return undefined;
  return {
    targetAuthorId: targetAuthor,
    targetSentAt: Number(targetTimestamp),
    status: status as 'pending' | 'ready' | 'failed',
    attachmentIds,
  };
}

type GroupChanged = Extract<AdapterEvent, { kind: 'groupChanged' }>;

export interface EventPumpDeps {
  emitter: Emitter<BackendEvents>;
  clock: Clock;
  directory: Directory;
  debug: (message: string, detail?: unknown) => void;
  storage: KeyValueStorage | undefined;
  /** The backend's current session; bumped on disconnect so queued work from an old one is dropped. */
  session: () => number;
  /** Per-account state, replaced on account selection. */
  identity: () => SelfIdentity;
  peers: () => DirectPeers | null;
  /** The storage key of the resume position for the selected account. */
  cursorKey: () => string;
  /** Tells the transport what is now stored (the desktop transport only). */
  acknowledgeTransport: (cursor: string) => void;
}

export class EventPump {
  private readonly groupChanges = new GroupChangeTracker();
  private queue: Promise<void> = Promise.resolve();
  /** `enqueue` calls whose events are not all applied yet. */
  private queuedBatches = 0;
  /** How many `catchingUp` signals have been emitted (see `CatchUpMark`). */
  private catchUpSeq = 0;

  constructor(private readonly deps: EventPumpDeps) {}

  private get emitter(): Emitter<BackendEvents> {
    return this.deps.emitter;
  }

  private get clock(): Clock {
    return this.deps.clock;
  }

  private get directory(): Directory {
    return this.deps.directory;
  }

  private get identity(): SelfIdentity {
    return this.deps.identity();
  }

  private get peers(): DirectPeers | null {
    return this.deps.peers();
  }

  private get selfId(): string {
    return this.identity.selfId;
  }

  private debugLog(message: string, detail?: unknown): void {
    this.deps.debug(message, detail);
  }

  /** Forgets pending group-update snapshots (disconnect, account selection). */
  clearGroupChanges(): void {
    this.groupChanges.clear();
  }

  onTransportEvent(event: TransportEvent): void {
    let events: AdapterEvent[] = [];
    if (event.type === 'receiveCatchingUp') {
      // Patched signal-cli only (patches/signal-cli/0020, build 21+): the receive
      // websocket (re)connected and the server is delivering what queued up.
      // No envelope; the receiveCaughtUp that follows ends it.
      this.emitter.emit('catchingUp', { seq: ++this.catchUpSeq });
    } else if (event.type === 'receiveCaughtUp') {
      // Patched signal-cli only (patches/signal-cli/0010): the receive loop
      // drained the server's queue. No envelope; nothing to normalise. Queued
      // like a message: it must not be emitted before the events that arrived
      // ahead of it have been applied (see the ordering contract above `enqueue`).
      events = [{ kind: 'caughtUp', payload: { seq: this.catchUpSeq } }];
    } else if (event.type === 'receiveConfigurationChanged') {
      // Patched signal-cli only (patches/signal-cli/0018): the privacy settings
      // changed; no values travel with it, the service re-reads them.
      this.emitter.emit('phonePrivacyChanged', undefined);
    } else if (event.type === 'attachmentBackfill') {
      // Patched signal-cli only (patches/signal-cli/0014): our primary
      // answered a requestAttachmentBackfill call.
      let payload: unknown;
      try {
        payload = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
      } catch {
        payload = undefined; // advisory: a malformed event is dropped below
      }
      const backfill = parseAttachmentBackfillEvent(payload);
      if (backfill) this.emitter.emit('attachmentBackfill', backfill);
      else this.debugLog('ignored malformed attachmentBackfill event');
    } else if (event.type !== 'receive') {
      this.debugLog(`ignored event "${event.type}"`);
    } else {
      try {
        // SSE delivers text; IPC delivers parsed JSON.
        const payload: unknown =
          typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        this.learnSelf(payload);
        this.learnPeers(payload);
        events = normaliseReceive(payload, this.normaliseContext());
      } catch {
        // Never log the data itself: it can be (or embed) raw message text.
        this.debugLog('ignored non-JSON event data', `${String(event.data).length} chars`);
      }
    }
    // Even an ignored event advances the resume position (once acknowledged).
    this.enqueue(events, event.cursor || undefined);
  }

  /** Learns our other identifier from payloads (see SelfIdentity). */
  private learnSelf(payload: unknown): void {
    if (!isRecord(payload)) return;
    // The daemon labels every event with the account it belongs to.
    if (typeof payload.account === 'string') this.identity.add(payload.account);
    const envelope = payload.envelope;
    if (isRecord(envelope)) {
      const uuid = typeof envelope.sourceUuid === 'string' ? envelope.sourceUuid : undefined;
      const number = typeof envelope.sourceNumber === 'string' ? envelope.sourceNumber : undefined;
      this.identity.learnPair(uuid, number);
    }
  }

  /**
   * Learns peer number↔ACI aliases (DirectPeers) from any raw payload: every
   * wire shape names an address pair the same way — a `<prefix>Uuid` field
   * alongside a `<prefix>Number` one (`source*`, `destination*`,
   * `targetAuthor*`, `sender*`, the legacy quote `author*`, …) — so walking
   * the tree for that shape, rather than hand-listing every field, keeps
   * this learning everywhere an alias could show up.
   */
  private learnPeers(payload: unknown): void {
    if (!this.peers) return;
    const seen = new Set<unknown>();
    const walk = (value: unknown): void => {
      if (!isRecord(value) || seen.has(value)) return;
      seen.add(value);
      for (const key of Object.keys(value)) {
        if (!key.endsWith('Uuid')) continue;
        const uuid = value[key];
        const number = value[`${key.slice(0, -4)}Number`];
        if (typeof uuid === 'string' && typeof number === 'string') {
          this.peers?.learnPair(uuid, number);
        }
      }
      for (const v of Object.values(value)) {
        if (Array.isArray(v)) v.forEach(walk);
        else walk(v);
      }
    };
    walk(payload);
  }

  private normaliseContext(): NormaliseContext {
    return {
      selfId: this.selfId,
      selfAliases: this.identity.aliases,
      resolvePeer: (id) => this.peers?.resolve(id) ?? id,
      now: this.clock.now(),
      nameOf: (id) => this.directory.contact(id)?.name,
      debug: this.deps.debug,
    };
  }

  /** Test hook: feeds a raw `receive` payload as if it came from the stream. */
  ingest(payload: unknown, cursor?: string): Promise<void> {
    this.learnSelf(payload);
    this.learnPeers(payload);
    this.enqueue(normaliseReceive(payload, this.normaliseContext()), cursor);
    return this.queue;
  }

  hasPendingEvents(): boolean {
    return this.queuedBatches > 0;
  }

  /** Resolves once every queued incoming event has been applied. */
  idle(): Promise<void> {
    return this.queue;
  }

  /** Persists the resume position once the sync engine has stored everything before it. */
  acknowledge(cursor: string): void {
    if (!this.selfId) return;
    try {
      this.deps.storage?.setItem(this.deps.cursorKey(), cursor);
    } catch (error) {
      ignore(error, 'resume position is an optimisation only; the worst case is re-delivery');
    }
    // The desktop transport stops holding what's now stored.
    this.deps.acknowledgeTransport(cursor);
  }

  /**
   * Ordering contract. Events reach the stores through two serial queues in
   * series, and what each one guarantees is what the layer above relies on:
   *
   * 1. This adapter queue applies decoded stream events strictly in arrival
   *    order and emits them (`message`, `messageEdited`, `reaction`, `receipt`,
   *    `readSync`, `conversationUpdated` from a group update, `caughtUp`, ...).
   *    The `checkpoint` for a stream position is emitted after every event of
   *    that position. `caughtUp` is one of these events: it is emitted only
   *    after everything that arrived before it.
   * 2. SyncService's queue then applies what this one emitted, again in order
   *    (parked in a backlog until the initial sync is done), and acknowledges
   *    a checkpoint only once everything before it is stored.
   *
   * Outside both queues, on purpose: `catchingUp` (it must run before the
   * backlog it announces), `status`, `typing`, `phonePrivacyChanged`,
   * `attachmentBackfill`, `contactUpdated` (ephemeral, or a later refresh
   * replaces them), and anything that waits on the network: the contact
   * listing (a profile refresh, up to minutes) and, in SyncService, read
   * receipts. An event is applied inside this queue only when order is the
   * point: a group update waits on a local `listGroups` so its diff and system
   * line land between the messages around it.
   */
  private enqueue(events: AdapterEvent[], cursor: string | undefined): void {
    const session = this.deps.session();
    // Snapshot group state *now*: a directory reload before this update is
    // processed would otherwise already contain the new state.
    for (const event of events) {
      if (event.kind === 'groupChanged') {
        this.groupChanges.arrived(
          event.conversationId,
          this.directory.group(event.conversationId),
          event.actorId,
        );
      }
    }
    this.queuedBatches++;
    this.queue = this.queue.then(async () => {
      try {
        for (const event of events) {
          if (session !== this.deps.session()) return;
          try {
            await this.apply(event);
          } catch (error) {
            // Never log the error object itself: its message can embed payload data.
            this.debugLog(`failed to apply ${event.kind}`, describeError(error));
          }
        }
        if (cursor && session === this.deps.session()) this.emitter.emit('checkpoint', { cursor });
      } finally {
        this.queuedBatches--;
      }
    });
  }

  private async apply(event: AdapterEvent): Promise<void> {
    switch (event.kind) {
      case 'message': {
        const message = event.payload;
        this.noteUnknown(message.conversationId, message.authorId);
        // Only a real message lists a DM or bumps its activity (see
        // notePeer): a system line (a decrypt failure, a timer change) is
        // still stored and shown in an already-listed conversation, but must
        // never create or raise one on its own.
        if (message.kind === 'normal') this.notePeer(message.conversationId, message.sentAt);
        this.emitter.emit('message', message);
        return;
      }
      case 'caughtUp':
        this.emitter.emit('caughtUp', event.payload);
        return;
      case 'expirationChanged':
        this.applyTimer(event.conversationId, event.seconds);
        return;
      case 'groupChanged':
        await this.applyGroupChange(event);
        return;
      case 'contactsChanged':
        // Contacts and groups syncs often arrive together (and either can
        // land first right after linking), so a sync of either kind
        // refreshes both, bypassing the cache TTL. The contact listing makes
        // signal-cli refresh profiles from the server (up to minutes), so it
        // never holds the queue: results arrive as `contactUpdated` /
        // `conversationUpdated`. The group listing is local to signal-cli and
        // stays in order, so a later group update's diff sees this state.
        void this.directory.loadContacts(true);
        await this.directory.loadGroups(true);
        return;
      case 'directoryHint':
        this.directory.scheduleContactsRefresh();
        return;
      case 'messageEdited':
        this.emitter.emit('messageEdited', event.payload);
        return;
      case 'messageDeleted':
        this.emitter.emit('messageDeleted', event.payload);
        return;
      case 'messagePinned':
        this.emitter.emit('messagePinned', event.payload);
        return;
      case 'reaction':
        this.emitter.emit('reaction', event.payload);
        return;
      case 'pollVote':
        this.emitter.emit('pollVote', event.payload);
        return;
      case 'pollTerminate':
        this.emitter.emit('pollTerminate', event.payload);
        return;
      case 'receipt':
        this.emitter.emit('receipt', event.payload);
        return;
      case 'typing':
        this.emitter.emit('typing', event.payload);
        return;
      case 'readSync':
        this.emitter.emit('readSync', event.payload);
        return;
      case 'messageRequestResponse':
        this.emitter.emit('messageRequestResponse', event.payload);
        return;
      case 'identityVerified':
        this.emitter.emit('identityVerified', event.payload);
        return;
      case 'deleteForMe':
        this.emitter.emit('deleteForMe', event.payload);
        return;
    }
  }

  /** Stale-directory triggers: a stranger wrote, or a group we don't know. */
  private noteUnknown(conversationId: ConversationId, authorId: string): void {
    if (authorId !== this.selfId && !this.directory.hasContact(authorId)) {
      this.directory.scheduleContactsRefresh();
    }
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind === 'group' && !this.directory.group(conversationId)) {
      // The sync engine re-lists conversations for unknown ids; make that fresh.
      this.directory.invalidateGroups();
    }
  }

  /**
   * Remembers a DM peer; announces the conversation the first time we see
   * it. `at` is always a real message's own `sentAt` (never a system line's,
   * and never this device's local receive time) — see the `kind === 'normal'`
   * guard at both call sites, and `chatLatestMessageAt`'s doc for why
   * `sentAt` rather than receive time keeps a replayed backlog in the
   * phone's order.
   */
  notePeer(conversationId: ConversationId, at: number): void {
    const parsed = parseConversationId(conversationId);
    if (parsed?.kind !== 'direct' || !this.peers) return;
    if (this.peers.touch(parsed.target, at)) {
      this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, at));
    }
  }

  directConversation(rawPeerId: string, lastActivityAt: number): Conversation {
    // Always the canonical form, so a conversation is never announced under a folded alias.
    const peerId = this.peers?.resolve(rawPeerId) ?? rawPeerId;
    return toDirectConversation(
      peerId,
      this.selfId,
      this.directory.contact(peerId),
      this.directory.dmTimer(peerId),
      lastActivityAt,
    );
  }

  applyTimer(conversationId: ConversationId, seconds: number): void {
    const parsed = parseConversationId(conversationId);
    if (!parsed) return;
    if (parsed.kind === 'direct') {
      this.directory.setDmTimer(parsed.target, seconds);
      // Same rule as onContactChanged: a timer change alone (no content of
      // its own — see normalise/envelope.ts's isExpirationUpdate branch)
      // must not announce, and so list, a DM we've never otherwise talked
      // to. Once a real message does arrive, directConversation reads the
      // timer set here fresh, so nothing is lost by not announcing it now.
      if (this.peers?.has(parsed.target)) {
        this.emitter.emit('conversationUpdated', this.directConversation(parsed.target, 0));
      }
      return;
    }
    const group = this.directory.group(conversationId);
    if (!group) return;
    const next = { ...group, expireTimerSec: seconds };
    this.directory.setGroup(next);
    this.emitter.emit('conversationUpdated', next);
  }

  private async applyGroupChange(event: GroupChanged): Promise<void> {
    const turn = this.groupChanges.take(event.conversationId);
    // A later update to the same group is queued: it will re-list and describe
    // the combined change (re-listing now would already show its state).
    if (!turn.last) return;
    const after = await this.directory.fetchGroup(event.groupId);
    if (!after) {
      // We left or were removed; keep history, just note it.
      this.emitSystem(event, 'You are no longer a member of this group.');
      return;
    }
    this.emitter.emit('conversationUpdated', after);
    const actorName = turn.actorId === null ? null : this.nameOf(turn.actorId);
    let lines: string[];
    if (!turn.before) {
      lines = [
        turn.actorId === this.selfId || actorName === null
          ? 'The group was updated.'
          : `${actorName} added you to the group.`,
      ];
    } else {
      lines = describeGroupChange(turn.before, after, actorName, (id) => this.nameOf(id));
      if (lines.length === 0) {
        lines = [actorName ? `${actorName} updated the group settings.` : 'The group was updated.'];
      }
    }
    this.emitSystem(event, lines.join(' '));
  }

  private emitSystem(event: GroupChanged, text: string): void {
    this.emitter.emit(
      'message',
      systemMessage(
        {
          conversationId: event.conversationId,
          authorId: event.actorId,
          receivedAt: this.clock.now(),
        },
        event.sentAt,
        text,
        'group',
      ),
    );
  }

  /** A local system line for a change we made from this device. */
  emitOwnSystem(conversationId: ConversationId, sentAt: number, text: string, kind: string): void {
    this.emitter.emit(
      'message',
      systemMessage(
        { conversationId, authorId: this.selfId, receivedAt: this.clock.now() },
        sentAt,
        text,
        kind,
      ),
    );
  }

  // Stripped here since the result feeds plain-text system sentences
  // (describeGroupChange) that no later CSS isolation can protect.
  nameOf(id: string): string {
    if (id === this.selfId) return 'You';
    return stripBidiControls(this.directory.contact(id)?.name ?? id);
  }
}
