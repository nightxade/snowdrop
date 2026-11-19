/**
 * What the user can do with a message request (core/domain/messageRequests):
 * accept it, delete it, block it, and unblock what they blocked. Each one
 * tells the backend first (it shares or withdraws the profile and syncs the
 * answer to the user's other devices) and only then changes what this device
 * knows, so a failure leaves the request exactly as it was, with the error
 * reported and a retry possible. A backend with no message requests of its
 * own (no `messageRequests` feature) just means the answer is local.
 */
import type { BackendEvents, ChatBackend, Feature } from '@/core/backend';
import {
  mustChooseNewAdmin,
  parseConversationId,
  requestAnswerText,
  systemMessageId,
  type ConversationId,
  type RequestAnswer,
} from '@/core/domain';
import { stripBidiControls, type Clock } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import { NO_UNREAD, type Stores } from '@/core/stores';
import { appendLocalSystemLine } from './localSystemLine';
import type { SyncService } from './SyncService';
import { consoleReporter, type ErrorReporter } from './types';

export interface MessageRequestServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  /** Sends the read receipts that waited for an accept. */
  sync: Pick<SyncService, 'sendHeldReadReceipts'>;
  clock: Clock;
  /** Called just before a deleted request's stored messages go (its in-flight sends must not come back). */
  onConversationDeleted?: (id: ConversationId) => void;
  onError?: ErrorReporter;
}

export class MessageRequestService {
  private readonly onError: ErrorReporter;
  /**
   * When each chat was last answered, here or (by `at`) on the phone. A synced
   * answer no newer than that is a replay of one already overtaken, and is dropped.
   */
  private readonly answeredAt = new Map<ConversationId, number>();

  constructor(private readonly deps: MessageRequestServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Whether the connected backend can block and unblock (menus hide the rest). */
  get canBlock(): boolean {
    return this.has('blocking');
  }

  /** Accepts a request: profile sharing starts, the phone is told, receipts for read messages go out. */
  async accept(id: ConversationId): Promise<boolean> {
    const { backend, stores, clock } = this.deps;
    if (!stores.conversations.getState().byId[id]) return false;
    if (
      !(await this.ask('accept a message request', 'messageRequests', () =>
        backend.respondToMessageRequest(id, 'accept'),
      ))
    )
      return false;
    this.stampAccepted(id, clock.now());
    this.answeredAt.set(id, clock.now());
    await this.noteAnswer(id, 'accepted');
    await this.sendHeldReceipts(id);
    return true;
  }

  /** Deletes a request: the sender is told nothing, a group is left, and the chat is gone from here. */
  async remove(id: ConversationId): Promise<boolean> {
    const { backend, stores, clock } = this.deps;
    if (!stores.conversations.getState().byId[id]) return false;
    if (
      !(await this.ask('delete a message request', 'messageRequests', () =>
        backend.respondToMessageRequest(id, 'delete'),
      ))
    )
      return false;
    this.answeredAt.set(id, clock.now());
    await this.deleteLocally(id, clock.now());
    return true;
  }

  /** The local half of a delete: the chat is hidden, forgotten and its stored messages go. */
  private async deleteLocally(id: ConversationId, at: number): Promise<void> {
    const { repository, stores } = this.deps;
    // Hidden first: nothing the backend or the history archive still names may bring it back.
    stores.local.getState().markDeleted(id, at);
    stores.conversations.getState().removeMany([id]);
    // Where the user had filed it goes too: a group that messages again starts in Home, not its old space.
    stores.spaces.getState().unassign(id);
    stores.conversations.getState().setUnread(id, NO_UNREAD);
    stores.messages.getState().closeWindow(id);
    this.deps.onConversationDeleted?.(id);
    try {
      await repository.deleteConversation(id);
    } catch (error) {
      this.onError(error, 'deleting a message request failed');
    }
  }

  /**
   * An answer the user gave on their phone (Desktop's `MessageRequestResponse`
   * sync): the same local state and timeline lines as answering here, but the
   * phone already did the rest, so nothing is sent: no backend call, no
   * profile sharing, no read receipts. Blocking a group does not leave it
   * either (as in Desktop, only a local action does).
   *
   * Safe to replay, also after a restart. An answer is dropped when it is not
   * newer than the chat's latest accept or delete stamp in `localStore`
   * (`acceptedChats` holds the time of the latest accept, `deletedChats` the
   * time of the delete), and an answer that already holds changes nothing and
   * writes the same lines under the same ids. A block time is not persisted
   * anywhere: a replayed block after a later local unblock is caught because
   * unblocking stamps an accept, and a replayed accept after a later local
   * block is caught because applying (or finding applied) an accept stamps it.
   *
   * One kind of clock in those stamps: wall-clock ms. A synced answer stamps
   * the phone's envelope time, an answer given here this device's clock, so
   * answers closer together than the two clocks' skew can be mis-ordered; the
   * failure is an answer being ignored, never one being applied twice.
   *
   * The local blocked flag is only a mirror: signal-cli (patch 0026) applies
   * the block or unblock to its own store from this same sync, and the next
   * directory refresh agrees with it. Nothing here asks the backend to block,
   * since that would send.
   */
  async applySynced(e: BackendEvents['messageRequestResponse']): Promise<void> {
    const { stores } = this.deps;
    const id = this.knownTarget(e);
    if (id === undefined) return;
    const last = this.answeredAt.get(id);
    if (last !== undefined && e.at <= last) return;
    const local = stores.local.getState();
    const deletedAt = local.deletedChats[id];
    // Overtaken by a delete (here or on the phone): nothing may bring the chat back or act on it.
    if (deletedAt !== undefined && deletedAt >= e.at) return;
    const acceptedAt = local.acceptedChats[id];
    const blocked = this.isBlocked(id);
    switch (e.answer) {
      case 'accept':
      case 'unblockAndAccept':
        // Overtaken by a later accept (or an unblock) of this chat.
        if (acceptedAt !== undefined && acceptedAt >= e.at) return;
        this.stampAccepted(id, e.at);
        // Already a normal chat: only the stamp, so a replay after a later local block stays dropped.
        if (acceptedAt !== undefined && !blocked) break;
        if (blocked) this.markBlocked(id, false);
        await this.noteAnswer(id, blocked ? 'unblocked' : 'accepted', e.at);
        break;
      case 'block':
      case 'blockAndSpam':
      case 'blockAndDelete':
        if (acceptedAt !== undefined && acceptedAt >= e.at) return;
        if (!blocked) {
          this.markBlocked(id, true);
          if (e.answer !== 'blockAndDelete') await this.noteAnswer(id, 'blocked', e.at);
        }
        if (e.answer === 'blockAndSpam') await this.noteReported(id, e.at);
        if (e.answer === 'blockAndDelete') await this.deleteIfStale(id, e.at);
        break;
      case 'delete':
        if (acceptedAt !== undefined && acceptedAt >= e.at) return;
        await this.deleteIfStale(id, e.at);
        break;
      case 'spam':
        await this.noteReported(id, e.at);
        break;
    }
    this.answeredAt.set(id, e.at);
  }

  /** The chat an answer is about, if it is one this device knows (a person's by ACI, else by number). */
  private knownTarget(e: BackendEvents['messageRequestResponse']): ConversationId | undefined {
    if (this.known(e.conversationId)) return e.conversationId;
    if (e.alsoKnownAs !== undefined && this.known(e.alsoKnownAs)) return e.alsoKnownAs;
    return undefined;
  }

  /** Records the time of the latest accept (`markAccepted` alone keeps the first). */
  private stampAccepted(id: ConversationId, at: number): void {
    const { local } = this.deps.stores;
    local.getState().markAccepted(id, at);
    const stamp = local.getState().acceptedChats[id];
    if (stamp !== undefined && stamp < at)
      local.setState((s) => ({ acceptedChats: { ...s.acceptedChats, [id]: at } }));
  }

  /**
   * "Reported as spam", once per report however many syncs say so: the line's
   * id comes from the report's time, so a replay finds its line by one read
   * instead of decrypting the chat.
   */
  private async noteReported(id: ConversationId, at: number): Promise<void> {
    const selfId = this.deps.stores.session.getState().self?.id;
    if (!selfId) return;
    if (await this.deps.repository.get(systemMessageId(selfId, at, 'request-reported'))) return;
    await this.noteAnswer(id, 'reported', at);
  }

  /** Deletes the chat unless something newer than the phone's answer is in it (a replay after a new request). */
  private async deleteIfStale(id: ConversationId, at: number): Promise<void> {
    const conversation = this.deps.stores.conversations.getState().byId[id];
    if (!conversation || conversation.lastActivityAt > at) return;
    await this.deleteLocally(id, at);
  }

  private isBlocked(id: ConversationId): boolean {
    const { stores } = this.deps;
    const conversation = stores.conversations.getState().byId[id];
    const parsed = parseConversationId(id);
    if (parsed?.kind === 'direct')
      return stores.contacts.getState().byId[parsed.target]?.blocked === true;
    return conversation?.blocked === true;
  }

  /**
   * Blocks the sender (or group). The conversation stays, shown as blocked with an Unblock action,
   * and its history is kept. Blocking a group also leaves it, as in Signal Desktop ("Block and
   * Leave"); a group the user can't leave yet (the only admin) is blocked but not left.
   */
  async block(id: ConversationId): Promise<boolean> {
    const { backend } = this.deps;
    if (!this.known(id)) return false;
    if (!(await this.ask('block', 'blocking', () => backend.setBlocked(id, true)))) return false;
    this.markBlocked(id, true);
    this.answeredAt.set(id, this.deps.clock.now());
    await this.noteAnswer(id, 'blocked');
    await this.leaveBlockedGroup(id);
    return true;
  }

  /** Unblocking is accepting, as in Signal's own clients. */
  async unblock(id: ConversationId): Promise<boolean> {
    const { backend, clock } = this.deps;
    if (!this.known(id)) return false;
    if (!(await this.ask('unblock', 'blocking', () => backend.setBlocked(id, false)))) return false;
    this.markBlocked(id, false);
    this.answeredAt.set(id, clock.now());
    await this.noteAnswer(id, 'unblocked');
    this.stampAccepted(id, clock.now());
    await this.sendHeldReceipts(id);
    return true;
  }

  /** A conversation on screen, or (for a person) a contact the backend lists, such as a blocked one with no chat. */
  private known(id: ConversationId): boolean {
    const { stores } = this.deps;
    if (stores.conversations.getState().byId[id] !== undefined) return true;
    const parsed = parseConversationId(id);
    return (
      parsed?.kind === 'direct' && stores.contacts.getState().byId[parsed.target] !== undefined
    );
  }

  /** Desktop's timeline line for the user's own answer ("You accepted the message request"), in a chat that exists. */
  private async noteAnswer(id: ConversationId, answer: RequestAnswer, at?: number): Promise<void> {
    const { stores } = this.deps;
    const conversation = stores.conversations.getState().byId[id];
    const selfId = stores.session.getState().self?.id;
    if (!conversation || !selfId) return;
    const isGroup = conversation.kind === 'group';
    const parsed = parseConversationId(id);
    const person =
      parsed?.kind === 'direct' ? stores.contacts.getState().byId[parsed.target]?.name : undefined;
    try {
      await appendLocalSystemLine(this.deps, {
        conversationId: id,
        authorId: selfId,
        text: requestAnswerText(answer, isGroup, person ? stripBidiControls(person) : undefined),
        tag: `request-${answer}`,
        keepUnread: true,
        previewless: true,
        ...(at !== undefined ? { at } : {}),
      });
    } catch (error) {
      this.onError(error, 'noting a message request answer failed');
    }
  }

  private async leaveBlockedGroup(id: ConversationId): Promise<void> {
    const { backend, stores } = this.deps;
    const group = stores.conversations.getState().byId[id];
    const selfId = stores.session.getState().self?.id ?? null;
    if (!group || group.kind !== 'group' || group.left || !this.has('groups')) return;
    if (!selfId || !group.memberIds.includes(selfId) || mustChooseNewAdmin(group, selfId)) return;
    if (!(await this.ask('leave a blocked group', 'groups', () => backend.leaveGroup(id, []))))
      return;
    // The backend announces the left group itself; this only makes sure of it.
    const now = stores.conversations.getState().byId[id];
    if (now && !now.left)
      stores.conversations.getState().upsert({
        ...now,
        memberIds: now.memberIds.filter((m) => m !== selfId),
        adminIds: now.adminIds.filter((m) => m !== selfId),
        left: true,
      });
  }

  private has(feature: Feature): boolean {
    return this.deps.backend.capabilities.features.has(feature);
  }

  /** Tells the backend, when it has `feature`; without it the answer is only local, so there's nothing to tell. */
  private async ask(what: string, feature: Feature, call: () => Promise<void>): Promise<boolean> {
    try {
      if (this.has(feature)) await call();
      return true;
    } catch (error) {
      this.onError(error, `could not ${what}`);
      return false;
    }
  }

  private async sendHeldReceipts(id: ConversationId): Promise<void> {
    try {
      await this.deps.sync.sendHeldReadReceipts(id);
    } catch (error) {
      this.onError(error, 'read receipts after accepting failed');
    }
  }

  /** What the backend will report once it re-lists: `Contact.blocked` for a DM, `Conversation.blocked` for a group. */
  private markBlocked(id: ConversationId, blocked: boolean): void {
    const { stores } = this.deps;
    const parsed = parseConversationId(id);
    if (parsed?.kind === 'direct') {
      const contact = stores.contacts.getState().byId[parsed.target];
      if (!contact) return;
      const { blocked: _previous, ...rest } = contact;
      stores.contacts.getState().upsert(blocked ? { ...rest, blocked: true } : rest);
      return;
    }
    const conversation = stores.conversations.getState().byId[id];
    if (!conversation) return;
    const { blocked: _previous, ...rest } = conversation;
    stores.conversations.getState().upsert(blocked ? { ...rest, blocked: true } : rest);
  }
}
