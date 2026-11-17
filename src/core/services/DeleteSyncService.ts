/**
 * "Delete for me" made on another of the user's devices (Signal's `DeleteForMe`
 * sync) applied here: the messages, or the stretch of a chat, they removed
 * there are removed from this device too. Already done on the phone, so
 * nothing is sent back. (The other direction is `SendService.deleteForMe`.)
 *
 * What counts as the stretch of a chat follows Signal Desktop's behaviour for
 * `conversationDeletes`: the newest of the messages the phone still held when
 * it cleared the chat that exists here is the end, and everything up to and
 * including it goes (in arrival order, as Desktop uses the receive time);
 * when none of them exists here, nothing is deleted. Only a full delete goes
 * on to clear what is left (system lines included), and only when no real
 * message remains: Desktop's "local only" delete refuses while an addressable
 * message is left, and so does this.
 */
import type { BackendEvents, DeletedForMeConversation, MessageRef } from '@/core/backend';
import {
  isPendingMessageId,
  messageId,
  type ConversationId,
  type Message,
  type MessageId,
} from '@/core/domain';
import { latestRealMessage, type MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import { refreshPreviewAfterRemoval } from './sidebarPreview';
import { consoleReporter, type ErrorReporter } from './types';

export interface DeleteSyncServiceDeps {
  repository: MessageRepository;
  stores: Stores;
  /** A message is gone: whatever was said about it stops applying (unread reactions, notifications). */
  announceRemoved: (message: Message) => void;
  /** A message is gone for good: a replay of it must not bring it back (the expiry path's tombstones). */
  rememberPurged: (id: MessageId) => void;
  onError?: ErrorReporter;
}

/** Messages read from the repository per step when clearing a chat. */
const PAGE = 200;

/**
 * How many of a chat's newest messages are searched for an edited message
 * addressed by a revision's timestamp (rare, and a message deleted on the
 * phone is almost always a recent one).
 */
const EDIT_SCAN = 1_000;

/** Finds a message of one conversation by author and sent time (see `finder`). */
type Find = (ref: MessageRef) => Promise<Message | undefined>;

export class DeleteSyncService {
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: DeleteSyncServiceDeps) {
    this.onError = deps.onError ?? consoleReporter;
  }

  /**
   * Applies a synced delete. A part that cannot be applied never stops the
   * others. The messages named for one chat leave the app's state together.
   */
  async apply(e: BackendEvents['deleteForMe']): Promise<void> {
    const finders = new Map<ConversationId, Find>();
    const find = (conversationId: ConversationId): Find => {
      let f = finders.get(conversationId);
      if (!f) finders.set(conversationId, (f = this.finder(conversationId)));
      return f;
    };
    const named = new Map<ConversationId, Map<MessageId, Message>>();
    for (const ref of e.messages) {
      try {
        const message = await find(ref.conversationId)(ref);
        if (!message) continue;
        const group = named.get(ref.conversationId) ?? new Map<MessageId, Message>();
        group.set(message.id, message);
        named.set(ref.conversationId, group);
      } catch (error) {
        this.onError(error, 'applying a synced message delete failed');
      }
    }
    for (const [conversationId, group] of named) {
      try {
        await this.remove(conversationId, [...group.values()]);
      } catch (error) {
        this.onError(error, 'applying a synced message delete failed');
      }
    }
    for (const conversation of e.conversations) {
      try {
        await this.clearConversation(conversation, find(conversation.conversationId));
      } catch (error) {
        this.onError(error, 'applying a synced chat delete failed');
      }
    }
  }

  /**
   * Looks a message up by author and sent time in one conversation. Signal
   * addresses a message by any of its revisions' times, so besides the
   * original (what the id holds) the time of the latest edit matches too.
   * The edited messages of the chat are read once, on the first miss. Earlier
   * revisions' times are not kept, so they cannot match.
   */
  private finder(conversationId: ConversationId): Find {
    let edited: Map<string, Message> | undefined;
    return async (ref) => {
      const direct = await this.deps.repository.get(messageId(ref.authorId, ref.sentAt));
      if (direct?.conversationId === conversationId) return direct;
      edited ??= await this.editedMessages(conversationId);
      return edited.get(`${ref.authorId}\u0000${ref.sentAt}`);
    };
  }

  /** The conversation's newest messages that were edited, by author and the time of their latest edit. */
  private async editedMessages(conversationId: ConversationId): Promise<Map<string, Message>> {
    const found = new Map<string, Message>();
    let before: number | undefined;
    for (let scanned = 0; scanned < EDIT_SCAN;) {
      const page = await this.deps.repository.page(conversationId, {
        ...(before === undefined ? {} : { before }),
        limit: PAGE,
      });
      const oldest = page[0];
      if (!oldest || oldest.seq === undefined) break;
      before = oldest.seq;
      scanned += page.length;
      for (const m of page) {
        if (m.editedAt !== undefined) found.set(`${m.authorId}\u0000${m.editedAt}`, m);
      }
    }
    return found;
  }

  private async clearConversation(c: DeletedForMeConversation, find: Find): Promise<void> {
    const { repository } = this.deps;
    const anchor =
      (await this.newest(c.mostRecent, find)) ?? (await this.newest(c.mostRecentNonExpiring, find));
    const cutoff = anchor?.seq;
    if (cutoff !== undefined) {
      await this.removeWhere(c.conversationId, (m) => m.seq !== undefined && m.seq <= cutoff);
    }
    if (!c.isFullDelete) return;
    // A real message left (including one still being sent) means this is not an empty chat.
    if (await latestRealMessage(repository, c.conversationId)) return;
    await this.removeWhere(c.conversationId, () => true);
  }

  /** The newest (by arrival) of the named messages that exists in the conversation. */
  private async newest(refs: readonly MessageRef[], find: Find): Promise<Message | undefined> {
    let found: Message | undefined;
    for (const ref of refs) {
      const message = await find(ref);
      if (message?.seq === undefined) continue;
      if (found?.seq === undefined || message.seq > found.seq) found = message;
    }
    return found;
  }

  /**
   * Removes every stored message of the conversation `match` accepts, newest
   * first, except an unsent one (it only exists here and is the user's to
   * discard). Storage first, then the app's state in one go, so the open list
   * changes once.
   */
  private async removeWhere(
    conversationId: ConversationId,
    match: (m: Message) => boolean,
  ): Promise<void> {
    const { repository } = this.deps;
    const removed: Message[] = [];
    let before: number | undefined;
    for (;;) {
      const page = await repository.page(conversationId, {
        ...(before === undefined ? {} : { before }),
        limit: PAGE,
      });
      const oldest = page[0];
      if (!oldest || oldest.seq === undefined) break;
      before = oldest.seq;
      for (const m of [...page].reverse()) {
        if (isPendingMessageId(m.id) || !match(m)) continue;
        await repository.delete(m.id);
        removed.push(m);
      }
    }
    await this.forget(conversationId, removed);
  }

  private async remove(conversationId: ConversationId, messages: Message[]): Promise<void> {
    for (const m of messages) await this.deps.repository.delete(m.id);
    await this.forget(conversationId, messages);
  }

  /**
   * Messages already deleted from storage leave the rest of the app: out of
   * the window (one update for the whole batch, so an open list changes once
   * and keeps its scroll position and focus) and the unread count, off the
   * sidebar preview, and whatever was said about them stops applying. They
   * are remembered as gone, so a replay of one does not bring it back. The
   * unread divider needs nothing: it reads the read position, not the messages.
   */
  private async forget(
    conversationId: ConversationId,
    messages: readonly Message[],
  ): Promise<void> {
    if (messages.length === 0) return;
    const { stores, repository, announceRemoved, rememberPurged } = this.deps;
    const selfId = stores.session.getState().self?.id;
    const previewId = stores.conversations.getState().lastMessage[conversationId]?.id;
    stores.messages.getState().removeMany(
      conversationId,
      messages.map((m) => m.id),
    );
    for (const m of messages) {
      rememberPurged(m.id);
      if (selfId) stores.conversations.getState().applyRemoval(m, selfId);
      announceRemoved(m);
    }
    const preview = messages.find((m) => m.id === previewId);
    if (preview) {
      await refreshPreviewAfterRemoval(stores.conversations, repository, conversationId, preview);
    }
  }
}
