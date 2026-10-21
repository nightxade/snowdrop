/**
 * What the user can do with a message request (core/domain/messageRequests):
 * accept it, delete it, block it, and unblock what they blocked. Each one
 * tells the backend first (it shares or withdraws the profile and syncs the
 * answer to the user's other devices) and only then changes what this device
 * knows, so a failure leaves the request exactly as it was, with the error
 * reported and a retry possible. A backend with no message requests of its
 * own (no `respondToMessageRequest`) just means the answer is local.
 */
import type { ChatBackend } from '@/core/backend';
import { parseConversationId, type ConversationId } from '@/core/domain';
import type { Clock } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import { NO_UNREAD, type Stores } from '@/core/stores';
import type { SyncService } from './SyncService';
import { consoleReporter, type ErrorReporter } from './types';

export interface MessageRequestServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  /** Sends the read receipts that waited for an accept. */
  sync: Pick<SyncService, 'sendHeldReadReceipts'>;
  clock: Clock;
  onError?: ErrorReporter;
}

export class MessageRequestService {
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: MessageRequestServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /** Accepts a request: profile sharing starts, the phone is told, receipts for read messages go out. */
  async accept(id: ConversationId): Promise<boolean> {
    const { backend, stores, clock } = this.deps;
    if (!stores.conversations.getState().byId[id]) return false;
    if (
      !(await this.ask('accept a message request', () =>
        backend.respondToMessageRequest?.(id, 'accept'),
      ))
    )
      return false;
    stores.local.getState().markAccepted(id, clock.now());
    await this.sendHeldReceipts(id);
    return true;
  }

  /** Deletes a request: the sender is told nothing, a group is left, and the chat is gone from here. */
  async remove(id: ConversationId): Promise<boolean> {
    const { backend, repository, stores, clock } = this.deps;
    if (!stores.conversations.getState().byId[id]) return false;
    if (
      !(await this.ask('delete a message request', () =>
        backend.respondToMessageRequest?.(id, 'delete'),
      ))
    )
      return false;
    // Hidden first: nothing the backend or the history archive still names may bring it back.
    stores.local.getState().markDeleted(id, clock.now());
    stores.conversations.getState().removeMany([id]);
    stores.conversations.getState().setUnread(id, NO_UNREAD);
    stores.messages.getState().closeWindow(id);
    try {
      await repository.deleteConversation(id);
    } catch (error) {
      this.onError(error, 'deleting a message request failed');
    }
    return true;
  }

  /** Blocks the sender (or group). The conversation stays, shown as blocked with an Unblock action. */
  async block(id: ConversationId): Promise<boolean> {
    const { backend } = this.deps;
    if (!this.known(id)) return false;
    if (!(await this.ask('block', () => backend.setBlocked?.(id, true)))) return false;
    this.markBlocked(id, true);
    return true;
  }

  /** Unblocking is accepting, as in Signal's own clients. */
  async unblock(id: ConversationId): Promise<boolean> {
    const { backend, stores, clock } = this.deps;
    if (!this.known(id)) return false;
    if (!(await this.ask('unblock', () => backend.setBlocked?.(id, false)))) return false;
    this.markBlocked(id, false);
    stores.local.getState().markAccepted(id, clock.now());
    await this.sendHeldReceipts(id);
    return true;
  }

  private known(id: ConversationId): boolean {
    return this.deps.stores.conversations.getState().byId[id] !== undefined;
  }

  private async ask(what: string, call: () => Promise<void> | undefined): Promise<boolean> {
    try {
      await call();
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
