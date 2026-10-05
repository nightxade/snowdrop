/**
 * Outgoing actions with optimistic UI.
 *
 * Sends appear immediately as `pending:<nonce>` rows (with a reserved seq, so
 * they keep their place in the timeline) and are persisted with their input
 * in an outbox, so a reload never loses what the user typed. When the
 * backend acknowledges, the row is reconciled to its real identity.
 *
 * Messages that are still pending can be edited, reacted to or deleted
 * without blocking the user: the effect is shown immediately and the backend
 * operation is queued and replayed against the real id once the send is
 * acknowledged. If the send never went out (it failed), an edit simply
 * rewrites what will be sent and a delete discards it.
 */
import type { ChatBackend, ConversationPatch, SendInput } from '@/core/backend';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyReaction,
  attachMentions,
  isPendingMessageId,
  mergeDuplicate,
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
import { localAttachment, withLocalUrls } from './localAttachments';
import { ReceiptBuffer } from './ReceiptBuffer';
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
  /** Shared with SyncService so receipts that beat our send's ack aren't lost. */
  receipts?: ReceiptBuffer;
  newNonce?: () => string;
  onError?: ErrorReporter;
}

export class NotSignedInError extends Error {
  override name = 'NotSignedInError';
}

/** An operation on a message that must wait for its send to be acknowledged. */
interface QueuedOp {
  context: string;
  apply: (m: Message) => Message;
  revert: (m: Message) => Message;
  commit: (target: Message) => Promise<void>;
}

interface Outgoing {
  conversationId: ConversationId;
  input: SendInput;
  inFlight: boolean;
  queue: QueuedOp[];
}

export class SendService {
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly typingSentAt = new Map<ConversationId, number>();
  private readonly pipeline: DraftPipeline;
  private readonly receipts: ReceiptBuffer;
  private readonly newNonce: () => string;
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: SendServiceDeps) {
    this.pipeline = deps.pipeline ?? PASSTHROUGH_PIPELINE;
    this.receipts = deps.receipts ?? new ReceiptBuffer();
    this.newNonce = deps.newNonce ?? (() => createNonce('msg'));
    this.onError = deps.onError ?? consoleReporter;
  }

  private selfId(): string {
    const self = this.deps.stores.session.getState().self;
    if (!self) throw new NotSignedInError('No account is connected');
    return self.id;
  }

  /**
   * Turns composer text into Signal body + ranges: markdown (per `format`, or
   * the user's setting when omitted) plus mentions.
   */
  compose(
    text: string,
    mentionIds: readonly string[],
    format?: OutgoingDraft['format'],
  ): { body: string; ranges: BodyRange[] } {
    const markdown =
      format === undefined
        ? this.deps.stores.settings.getState().behaviour.markdown
        : format === 'markdown';
    const parsed = markdown ? parseMarkdownToRanges(text) : { body: text, ranges: [] };
    return { body: parsed.body, ranges: attachMentions(parsed.body, parsed.ranges, mentionIds) };
  }

  // ─── Sending ───────────────────────────────────────────────────────────

  /**
   * Sends a draft. Resolves with the message's nonce (a stable handle for
   * retry/discard), or null if the draft was empty after transforms. Never
   * rejects for network errors — those surface as a "failed" message.
   * The message is only visible if the conversation window is anchored to
   * the present; the UI jumps there before sending.
   */
  async send(draft: OutgoingDraft): Promise<string | null> {
    const selfId = this.selfId();
    const transformed = await this.pipeline.transform(draft);
    const { body, ranges } = this.compose(
      transformed.text,
      transformed.mentionIds,
      transformed.format,
    );
    if (body.trim() === '' && transformed.attachments.length === 0) return null;

    const { repository, stores, clock } = this.deps;
    const nonce = this.newNonce();
    const now = clock.now();
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
      // Reserved now so the message keeps its place however long the send takes.
      seq: await repository.allocateSeq(),
      body,
      ranges,
      attachments: transformed.attachments.map((a, i) => localAttachment(a, `${nonce}-${i}`)),
      reactions: [],
      status: 'pending',
      kind: 'normal',
      nonce,
    };
    if (input.quote) optimistic.quote = input.quote;

    this.outgoing.set(nonce, {
      conversationId: input.conversationId,
      input,
      inFlight: false,
      queue: [],
    });
    stores.messages.getState().appendLive(optimistic);
    stores.conversations.getState().bumpActivity(input.conversationId, now);
    stores.conversations.getState().noteLatest(optimistic);
    this.typingSentAt.delete(input.conversationId);
    // Row and outbox entry together, or neither: a crash can't orphan one.
    await repository.stageOutgoing(optimistic, { nonce, input, createdAt: now });
    await this.attempt(nonce);
    return nonce;
  }

  /**
   * Restores unsent messages after a restart. They were interrupted, so they
   * come back as failed (with Retry) rather than silently re-sending.
   */
  async restoreOutbox(): Promise<number> {
    const { repository, stores } = this.deps;
    const entries = await repository.listOutbox();
    const selfId = stores.session.getState().self?.id;
    for (const entry of entries) {
      if (this.outgoing.has(entry.nonce)) continue;
      const id = pendingMessageId(entry.nonce);
      const conversationId = entry.input.conversationId;
      this.outgoing.set(entry.nonce, {
        conversationId,
        input: entry.input,
        inFlight: false,
        queue: [],
      });
      const markFailed = (m: Message): Message => ({ ...m, status: 'failed' });
      const existing = await repository.update(id, markFailed);
      if (existing) {
        stores.messages.getState().update(conversationId, id, markFailed);
        continue;
      }
      if (!selfId) continue;
      // Outbox entry without its row (older data, or storage that lost it):
      // rebuild the row from the input so the message is visible and retryable.
      const row: Message = {
        id,
        conversationId,
        authorId: selfId,
        sentAt: entry.createdAt,
        receivedAt: entry.createdAt,
        seq: await repository.allocateSeq(),
        body: entry.input.body,
        ranges: entry.input.ranges,
        attachments: (entry.input.attachments ?? []).map((a, i) => ({
          id: `${entry.nonce}-${i}`,
          contentType: a.contentType,
          fileName: a.fileName,
          size: a.data.size,
        })),
        reactions: [],
        status: 'failed',
        kind: 'normal',
        nonce: entry.nonce,
        ...(entry.input.quote ? { quote: entry.input.quote } : {}),
      };
      await repository.stageOutgoing(row, entry);
      stores.messages.getState().appendLive(row);
    }
    return entries.length;
  }

  /** Re-sends a failed message with its original (or since edited) input. */
  async retry(conversationId: ConversationId, nonce: string): Promise<void> {
    const out = this.outgoing.get(nonce);
    if (!out || out.inFlight) return;
    // Set synchronously, before any await: two overlapping retry() calls
    // (a double-click, or a manual retry racing an auto-retry) must not
    // both pass the guard above and both call attempt().
    out.inFlight = true;
    try {
      const setPending = (m: Message): Message => ({ ...m, status: 'pending' });
      this.deps.stores.messages
        .getState()
        .update(conversationId, pendingMessageId(nonce), setPending);
      await this.deps.repository.update(pendingMessageId(nonce), setPending);
    } catch (error) {
      // attempt() never ran, so it won't clear this itself.
      out.inFlight = false;
      throw error;
    }
    await this.attempt(nonce);
  }

  /** Drops a message that was never delivered. */
  async discard(conversationId: ConversationId, nonce: string): Promise<void> {
    const out = this.outgoing.get(nonce);
    if (out?.inFlight) return;
    this.outgoing.delete(nonce);
    this.deps.stores.messages.getState().remove(conversationId, pendingMessageId(nonce));
    await this.deps.repository.discardOutgoing(nonce);
  }

  private async attempt(nonce: string): Promise<void> {
    const out = this.outgoing.get(nonce);
    if (!out) return;
    const { repository, stores, backend, clock } = this.deps;
    const pendingId = pendingMessageId(nonce);
    out.inFlight = true;
    let result;
    try {
      result = await backend.send(out.input);
    } catch (error) {
      out.inFlight = false;
      const markFailed = (m: Message): Message => ({ ...m, status: 'failed' });
      stores.messages.getState().update(out.conversationId, pendingId, markFailed);
      await repository.update(pendingId, markFailed);
      this.onError(error, 'send failed');
      return;
    }

    const selfId = this.selfId();
    const pendingRow =
      stores.messages.getState().findByNonce(out.conversationId, nonce) ??
      (await repository.get(pendingId));
    // What was actually sent — queued edits/reactions are replayed below.
    const final: Message = {
      id: messageId(selfId, result.sentAt),
      conversationId: out.conversationId,
      authorId: selfId,
      sentAt: result.sentAt,
      receivedAt: pendingRow?.receivedAt ?? clock.now(),
      body: out.input.body,
      ranges: out.input.ranges,
      attachments: withLocalUrls(result.attachments, pendingRow?.attachments),
      reactions: [],
      // A receipt may already have arrived for this timestamp.
      status: advanceStatus('sent', this.receipts.take(result.sentAt, clock.now()) ?? 'sent'),
      kind: 'normal',
      nonce,
      ...(pendingRow?.seq === undefined ? {} : { seq: pendingRow.seq }),
      ...(out.input.quote ? { quote: out.input.quote } : {}),
      ...(result.recipientFailures?.length
        ? { failedRecipients: result.recipientFailures.map((f) => f.recipientId) }
        : {}),
    };

    // Merge (not overwrite): a sync echo or receipts may have landed already.
    let { message: stored } = await repository.commitOutgoing(nonce, final, mergeDuplicate);
    this.outgoing.delete(nonce);
    // A receipt handled while we were committing found no row and was parked; claim it now.
    const late = this.receipts.take(result.sentAt, clock.now());
    if (late !== undefined) {
      stored =
        (await repository.update(stored.id, (m) => ({
          ...m,
          status: advanceStatus(m.status, late),
        }))) ?? stored;
    }
    // Re-read right before showing it: receipts applied to the stored row after
    // the commit never reached the store (it still held the pending row).
    stored = (await repository.get(stored.id)) ?? stored;

    // Show the queued operations' effects straight away; commit them next.
    const shown = out.queue.reduce((m, op) => op.apply(m), stored);
    stores.messages.getState().reconcile(out.conversationId, nonce, shown);
    stores.conversations.getState().noteLatest(shown);
    if (
      stored.seq !== undefined &&
      stores.conversations.getState().markRead(out.conversationId, stored.seq)
    ) {
      // Replying means you've seen everything before it.
      await repository.setReadCursor(out.conversationId, stored.seq);
    }
    for (const op of out.queue) await this.commitQueued(out.conversationId, stored, op);
  }

  private async commitQueued(
    conversationId: ConversationId,
    target: Message,
    op: QueuedOp,
  ): Promise<void> {
    try {
      await op.commit(target);
      await this.deps.repository.update(target.id, op.apply);
    } catch (error) {
      this.deps.stores.messages.getState().update(conversationId, target.id, op.revert);
      this.onError(error, op.context);
    }
  }

  /**
   * Routes an operation: acknowledged messages go through the optimistic
   * commit path; pending ones show it now and queue the commit.
   */
  private async operate(
    conversationId: ConversationId,
    id: MessageId,
    op: QueuedOp,
  ): Promise<boolean> {
    if (!isPendingMessageId(id)) return this.optimistic(conversationId, id, op);
    const nonce = id.slice('pending:'.length);
    const out = this.outgoing.get(nonce);
    if (!out) return false;
    this.deps.stores.messages.getState().update(conversationId, id, op.apply);
    out.queue.push(op);
    return true;
  }

  // ─── Edit / react / delete ─────────────────────────────────────────────

  private findLoaded(conversationId: ConversationId, id: MessageId): Message | undefined {
    return this.deps.stores.messages.getState().windows[conversationId]?.byId[id];
  }

  /** Edits one of our messages; see the class comment for pending messages. */
  async edit(
    conversationId: ConversationId,
    id: MessageId,
    text: string,
    mentionIds: readonly string[] = [],
  ): Promise<boolean> {
    const original = this.findLoaded(conversationId, id);
    if (!original || original.authorId !== this.selfId() || original.deleted) return false;
    const { body, ranges } = this.compose(text, mentionIds);
    if (body.trim() === '' || (body === original.body && sameRanges(ranges, original.ranges))) {
      return false;
    }

    // Not sent yet (failed): just change what will be sent — no edit needed.
    const nonce = original.nonce;
    const out = nonce === undefined ? undefined : this.outgoing.get(nonce);
    if (nonce !== undefined && out && !out.inFlight && isPendingMessageId(id)) {
      out.input = { ...out.input, body, ranges };
      const rewrite = (m: Message): Message => ({ ...m, body, ranges });
      this.deps.stores.messages.getState().update(conversationId, id, rewrite);
      await Promise.all([
        this.deps.repository.update(id, rewrite),
        this.deps.repository.putOutbox({
          nonce,
          input: out.input,
          createdAt: original.receivedAt,
        }),
      ]);
      return true;
    }

    let editedAt = this.deps.clock.now();
    return this.operate(conversationId, id, {
      context: 'edit failed',
      apply: (m) => applyEdit(m, { body, ranges, editedAt }),
      revert: (m) => restoreContent(m, original),
      commit: async (target) => {
        // signal-cli rebuilds the whole data message from the edit's params:
        // without the original quote the edit would drop the reply context.
        const result = await this.deps.backend.edit({
          conversationId,
          targetSentAt: target.sentAt,
          body,
          ranges,
          ...(target.quote ? { quote: target.quote } : {}),
        });
        editedAt = result.sentAt;
      },
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
    return this.operate(conversationId, target.id, {
      context: 'reaction failed',
      apply: (m) => ({ ...m, reactions: applyReaction(m.reactions, reaction, remove) }),
      revert: (m) => ({
        ...m,
        reactions: [
          ...m.reactions.filter((r) => r.authorId !== selfId),
          ...(previous ? [previous] : []),
        ],
      }),
      commit: (real) =>
        this.deps.backend.react({
          conversationId,
          targetAuthorId: real.authorId,
          targetSentAt: real.sentAt,
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
    const nonce = target.nonce;
    const out = nonce === undefined ? undefined : this.outgoing.get(nonce);
    if (nonce !== undefined && out && !out.inFlight && isPendingMessageId(target.id)) {
      // Never delivered: deleting for everyone is just discarding it.
      await this.discard(conversationId, nonce);
      return true;
    }
    return this.operate(conversationId, target.id, {
      context: 'delete failed',
      apply: (m) => applyDelete(m),
      revert: () => target,
      commit: (real) => this.deps.backend.deleteForEveryone(conversationId, real.sentAt),
    });
  }

  /** What the transport supports beyond the required contract (menus hide the rest). */
  get capabilities(): { pin: boolean; adminDelete: boolean; updateConversation: boolean } {
    return {
      pin: this.deps.backend.pinMessage !== undefined,
      adminDelete: this.deps.backend.adminDelete !== undefined,
      updateConversation: this.deps.backend.updateConversation !== undefined,
    };
  }

  /** Pins or unpins a message for everyone, when the transport supports pins. */
  async pin(conversationId: ConversationId, target: Message, pin: boolean): Promise<boolean> {
    const pinMessage = this.deps.backend.pinMessage?.bind(this.deps.backend);
    if (!pinMessage || target.deleted || target.kind !== 'normal') return false;
    const set =
      (value: boolean) =>
      (m: Message): Message => {
        const { pinned: _pinned, ...rest } = m;
        return value ? { ...rest, pinned: true } : rest;
      };
    return this.operate(conversationId, target.id, {
      context: pin ? 'pin failed' : 'unpin failed',
      apply: set(pin),
      revert: set(target.pinned === true),
      commit: (real) =>
        pinMessage({
          conversationId,
          targetAuthorId: real.authorId,
          targetSentAt: real.sentAt,
          pin,
        }),
    });
  }

  /** A group admin deleting someone else's message, when the transport supports it. */
  async adminDelete(conversationId: ConversationId, target: Message): Promise<boolean> {
    const adminDelete = this.deps.backend.adminDelete?.bind(this.deps.backend);
    if (!adminDelete || target.deleted || isPendingMessageId(target.id)) return false;
    const selfId = this.selfId();
    return this.optimistic(conversationId, target.id, {
      context: 'delete failed',
      apply: (m) => applyDelete(m, selfId),
      revert: () => target,
      commit: (real) =>
        adminDelete(conversationId, { authorId: real.authorId, sentAt: real.sentAt }),
    });
  }

  /**
   * Removes a message from this device only. Unsent messages are discarded
   * (nothing to keep); everything else is dropped from history and the view.
   */
  async deleteForMe(conversationId: ConversationId, target: Message): Promise<void> {
    const nonce = target.nonce;
    if (nonce !== undefined && isPendingMessageId(target.id) && this.outgoing.has(nonce)) {
      await this.discard(conversationId, nonce);
      return;
    }
    this.deps.stores.messages.getState().remove(conversationId, target.id);
    await this.deps.repository.delete(target.id);
  }

  // ─── Conversation settings ─────────────────────────────────────────────

  /**
   * Changes the disappearing-messages timer, group name or description for
   * everyone. Not optimistic: the conversation updates (and the "You set…"
   * system line appears) when the transport confirms. Failures are reported
   * and resolve to false.
   */
  async updateConversation(
    conversationId: ConversationId,
    patch: ConversationPatch,
  ): Promise<boolean> {
    const update = this.deps.backend.updateConversation?.bind(this.deps.backend);
    if (!update) return false;
    try {
      await update(conversationId, patch);
      return true;
    } catch (error) {
      this.onError(error, 'conversation update failed');
      return false;
    }
  }

  // ─── Typing ────────────────────────────────────────────────────────────

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
  private async optimistic(
    conversationId: ConversationId,
    id: MessageId,
    op: QueuedOp,
  ): Promise<boolean> {
    const target = this.findLoaded(conversationId, id) ?? (await this.deps.repository.get(id));
    if (!target) return false;
    this.deps.stores.messages.getState().update(conversationId, id, op.apply);
    try {
      await op.commit(target);
    } catch (error) {
      this.deps.stores.messages.getState().update(conversationId, id, op.revert);
      this.onError(error, op.context);
      return false;
    }
    await this.deps.repository.update(id, op.apply);
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
