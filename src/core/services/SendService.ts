/**
 * Outgoing actions with optimistic UI.
 *
 * Every action updates the stores immediately, then talks to the backend and
 * either confirms (reconcile + persist) or rolls back. Sends that fail stay in
 * the list as "failed" with the original input kept for retry, so nothing the
 * user typed is ever lost.
 */
import type { ChatBackend, SendInput } from '@/core/backend';
import {
  applyDelete,
  applyEdit,
  applyReaction,
  attachMentions,
  messageId,
  parseMarkdownToRanges,
  pendingMessageId,
  type BodyRange,
  type ConversationId,
  type Message,
  type MessageId,
} from '@/core/domain';
import { createNonce, type Clock } from '@/core/lib';
import type { MessageRepository } from '@/core/persistence';
import type { Stores } from '@/core/stores';
import {
  consoleReporter,
  PASSTHROUGH_PIPELINE,
  type DraftPipeline,
  type ErrorReporter,
  type OutgoingDraft,
} from './types';

/** Signal clients resend "typing" about every 10 s; more often is noise. */
export const TYPING_REFRESH_MS = 10_000;

export interface SendServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  pipeline?: DraftPipeline;
  newNonce?: () => string;
  onError?: ErrorReporter;
}

export class NotSignedInError extends Error {
  override name = 'NotSignedInError';
}

export class SendService {
  private readonly pending = new Map<string, SendInput>();
  private readonly typingSentAt = new Map<ConversationId, number>();
  private readonly pipeline: DraftPipeline;
  private readonly newNonce: () => string;
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: SendServiceDeps) {
    this.pipeline = deps.pipeline ?? PASSTHROUGH_PIPELINE;
    this.newNonce = deps.newNonce ?? (() => createNonce('msg'));
    this.onError = deps.onError ?? consoleReporter;
  }

  private selfId(): string {
    const self = this.deps.stores.session.getState().self;
    if (!self) throw new NotSignedInError('No account is connected');
    return self.id;
  }

  /** Turns composer text into Signal body + ranges (markdown if enabled, plus mentions). */
  compose(text: string, mentionIds: readonly string[]): { body: string; ranges: BodyRange[] } {
    const markdown = this.deps.stores.settings.getState().behaviour.markdown;
    const parsed = markdown ? parseMarkdownToRanges(text) : { body: text, ranges: [] };
    return { body: parsed.body, ranges: attachMentions(parsed.body, parsed.ranges, mentionIds) };
  }

  /**
   * Sends a draft. Resolves with the optimistic message's nonce (a stable
   * handle for retry/discard), or null if the draft was empty after transforms.
   * Never rejects for network errors — those surface as a "failed" message.
   */
  async send(draft: OutgoingDraft): Promise<string | null> {
    const selfId = this.selfId();
    const transformed = await this.pipeline.transform(draft);
    const { body, ranges } = this.compose(transformed.text, transformed.mentionIds);
    if (body.trim() === '' && transformed.attachments.length === 0) return null;

    const nonce = this.newNonce();
    const now = this.deps.clock.now();
    const input: SendInput = {
      conversationId: transformed.conversationId,
      body,
      ranges,
      attachments: transformed.attachments,
    };
    if (transformed.quote) input.quote = transformed.quote;

    const optimistic: Message = {
      id: pendingMessageId(nonce),
      conversationId: input.conversationId,
      authorId: selfId,
      sentAt: now,
      receivedAt: now,
      body,
      ranges,
      attachments: transformed.attachments.map((a, i) => ({
        id: `${nonce}-${i}`,
        contentType: a.contentType,
        fileName: a.fileName,
        size: a.data.size,
      })),
      reactions: [],
      status: 'pending',
      kind: 'normal',
      nonce,
    };
    if (input.quote) optimistic.quote = input.quote;

    this.pending.set(nonce, input);
    this.deps.stores.messages.getState().upsert(optimistic);
    this.deps.stores.conversations.getState().bumpActivity(input.conversationId, now);
    this.typingSentAt.delete(input.conversationId);
    await this.attempt(nonce);
    return nonce;
  }

  /** Re-sends a failed message with its original input. */
  async retry(conversationId: ConversationId, nonce: string): Promise<void> {
    if (!this.pending.has(nonce)) return;
    this.deps.stores.messages
      .getState()
      .update(conversationId, pendingMessageId(nonce), (m) => ({ ...m, status: 'pending' }));
    await this.attempt(nonce);
  }

  /** Drops a failed (never delivered) message. */
  discard(conversationId: ConversationId, nonce: string): void {
    this.pending.delete(nonce);
    this.deps.stores.messages.getState().remove(conversationId, pendingMessageId(nonce));
  }

  private async attempt(nonce: string): Promise<void> {
    const input = this.pending.get(nonce);
    if (!input) return;
    const messages = this.deps.stores.messages.getState();
    const optimisticId = pendingMessageId(nonce);
    try {
      const result = await this.deps.backend.send(input);
      const selfId = this.selfId();
      const base: Message = messages.findByNonce(input.conversationId, nonce) ?? {
        // The optimistic row can be gone if the window was reset; rebuild from the input.
        id: optimisticId,
        conversationId: input.conversationId,
        authorId: selfId,
        sentAt: result.sentAt,
        receivedAt: result.sentAt,
        body: input.body,
        ranges: input.ranges,
        attachments: [],
        reactions: [],
        status: 'pending',
        kind: 'normal',
        ...(input.quote ? { quote: input.quote } : {}),
      };
      const final: Message = {
        ...base,
        id: messageId(selfId, result.sentAt),
        sentAt: result.sentAt,
        receivedAt: result.sentAt,
        attachments: result.attachments ?? base.attachments,
        status: 'sent',
      };
      this.pending.delete(nonce);
      this.deps.stores.messages.getState().reconcile(input.conversationId, nonce, final);
      await this.deps.repository.put(final);
      // Replying means you've seen everything before it.
      if (this.deps.stores.conversations.getState().markRead(input.conversationId, result.sentAt)) {
        await this.deps.repository.setReadCursor(input.conversationId, result.sentAt);
      }
    } catch (error) {
      this.deps.stores.messages
        .getState()
        .update(input.conversationId, optimisticId, (m) => ({ ...m, status: 'failed' }));
      this.onError(error, 'send failed');
    }
  }

  /** Optimistically edits one of our messages; rolls back on failure. */
  async edit(
    conversationId: ConversationId,
    id: MessageId,
    text: string,
    mentionIds: readonly string[] = [],
  ): Promise<boolean> {
    const original = this.deps.stores.messages.getState().windows[conversationId]?.byId[id];
    if (!original || original.authorId !== this.selfId() || original.deleted) return false;
    const { body, ranges } = this.compose(text, mentionIds);
    if (body.trim() === '' || (body === original.body && sameRanges(ranges, original.ranges))) {
      return false;
    }
    const optimisticAt = this.deps.clock.now();
    let editedAt = optimisticAt;
    return this.optimistic({
      conversationId,
      id,
      context: 'edit failed',
      apply: (m) => applyEdit(m, { body, ranges, editedAt }),
      revert: (m) => restoreContent(m, original),
      commit: async () => {
        const result = await this.deps.backend.edit({
          conversationId,
          targetSentAt: original.sentAt,
          body,
          ranges,
        });
        editedAt = result.sentAt;
      },
      // Store already shows the edit; just adopt the server timestamp.
      confirm: (m) => ({ ...m, editedAt }),
    });
  }

  /** Adds, replaces or (when `remove`) removes our reaction on a message. */
  async react(
    conversationId: ConversationId,
    target: Message,
    emoji: string,
    remove = false,
  ): Promise<boolean> {
    const selfId = this.selfId();
    const reaction = { emoji, authorId: selfId, at: this.deps.clock.now() };
    const previous = target.reactions.find((r) => r.authorId === selfId);
    return this.optimistic({
      conversationId,
      id: target.id,
      context: 'reaction failed',
      apply: (m) => ({ ...m, reactions: applyReaction(m.reactions, reaction, remove) }),
      revert: (m) => ({
        ...m,
        reactions: [
          ...m.reactions.filter((r) => r.authorId !== selfId),
          ...(previous ? [previous] : []),
        ],
      }),
      commit: () =>
        this.deps.backend.react({
          conversationId,
          targetAuthorId: target.authorId,
          targetSentAt: target.sentAt,
          emoji,
          remove,
        }),
    });
  }

  /** Clicking a reaction pill: toggles our reaction with that emoji. */
  toggleReaction(conversationId: ConversationId, target: Message, emoji: string): Promise<boolean> {
    const selfId = this.selfId();
    const mine = target.reactions.some((r) => r.authorId === selfId && r.emoji === emoji);
    return this.react(conversationId, target, emoji, mine);
  }

  async deleteForEveryone(conversationId: ConversationId, target: Message): Promise<boolean> {
    if (target.authorId !== this.selfId() || target.deleted) return false;
    return this.optimistic({
      conversationId,
      id: target.id,
      context: 'delete failed',
      apply: applyDelete,
      revert: () => target,
      commit: () => this.deps.backend.deleteForEveryone(conversationId, target.sentAt),
    });
  }

  /**
   * Reports composer activity. Throttled to one "started" per
   * TYPING_REFRESH_MS; "stopped" is only sent if "started" was.
   * Suppressed by the user setting or any plugin typing guard.
   */
  async setTyping(conversationId: ConversationId, typing: boolean): Promise<void> {
    const allowed =
      this.deps.stores.settings.getState().behaviour.sendTypingIndicators &&
      this.pipeline.allowsTyping(conversationId);
    const last = this.typingSentAt.get(conversationId);
    const now = this.deps.clock.now();
    if (typing) {
      if (!allowed || (last !== undefined && now - last < TYPING_REFRESH_MS)) return;
      this.typingSentAt.set(conversationId, now);
    } else {
      if (last === undefined) return;
      this.typingSentAt.delete(conversationId);
    }
    try {
      await this.deps.backend.setTyping(conversationId, typing);
    } catch (error) {
      // Typing indicators are best-effort; never bother the user about them.
      this.onError(error, 'typing indicator failed');
    }
  }

  /**
   * Applies an operation to the store immediately, commits it to the backend,
   * then persists it — or reverts it. Operations are functions (not snapshots)
   * so concurrent incoming changes to the same message survive both paths.
   */
  private async optimistic(op: {
    conversationId: ConversationId;
    id: MessageId;
    context: string;
    apply: (m: Message) => Message;
    revert: (m: Message) => Message;
    commit: () => Promise<unknown>;
    confirm?: (m: Message) => Message;
  }): Promise<boolean> {
    const { conversationId, id } = op;
    this.deps.stores.messages.getState().update(conversationId, id, op.apply);
    try {
      await op.commit();
    } catch (error) {
      this.deps.stores.messages.getState().update(conversationId, id, op.revert);
      this.onError(error, op.context);
      return false;
    }
    const confirm = op.confirm;
    if (confirm) this.deps.stores.messages.getState().update(conversationId, id, confirm);
    await this.deps.repository.update(id, (m) => (confirm ? confirm(op.apply(m)) : op.apply(m)));
    return true;
  }
}

/** Puts an original message's content fields back, including absent optionals. */
function restoreContent(m: Message, original: Message): Message {
  const { edits: _e, editedAt: _t, ...rest } = m;
  return {
    ...rest,
    body: original.body,
    ranges: original.ranges,
    ...(original.edits === undefined ? {} : { edits: original.edits }),
    ...(original.editedAt === undefined ? {} : { editedAt: original.editedAt }),
  };
}

function sameRanges(a: readonly BodyRange[], b: readonly BodyRange[]): boolean {
  return (
    a.length === b.length &&
    a.every((r, i) => {
      const o = b[i];
      return (
        o !== undefined &&
        r.start === o.start &&
        r.length === o.length &&
        r.style === o.style &&
        r.mentionId === o.mentionId
      );
    })
  );
}
