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
import type {
  ChatBackend,
  Feature,
  ConversationPatch,
  OutgoingCustomEmoji,
  OutgoingLinkPreview,
  OutgoingPoll,
  SendInput,
  SendResult,
} from '@/core/backend';
import {
  expandTextEmoticons,
  extractCustomEmojiNames,
  isImageCustomEmoji,
  type ImageCustomEmoji,
} from '@/core/stores/customEmoji';
import {
  advanceStatus,
  applyDelete,
  applyEdit,
  applyPollTerminate,
  attachmentProblem,
  attachmentProblemMessage,
  applyPollVote,
  applyReaction,
  attachMentions,
  escapeMarkdown,
  isEditableContent,
  isWithinDeleteWindow,
  isPendingMessageId,
  mergeOutgoingCommit,
  mergeReceipts,
  messageId,
  nextPollVoteCount,
  parseMarkdownToRanges,
  pendingMessageId,
  pinnedText,
  pollEndedText,
  pollVoteOf,
  reopenPoll,
  restorePollVote,
  type BodyRange,
  type ConversationId,
  type LinkPreview,
  type Message,
  type MessageId,
  type PollVote,
  type Quote,
  type StickerContent,
} from '@/core/domain';
import {
  createLogger,
  createNonce,
  pollDraftProblem,
  tidyPollDraft,
  toAppError,
  AppError,
  type Clock,
  ignore,
  ignored,
} from '@/core/lib';
import type { MessageRepository, OutboxEntry, SentMedia } from '@/core/persistence';
import { effectivePrivacy, selectMessageRequestState, type Stores } from '@/core/stores';
import {
  followPreview,
  refreshPreviewAfterRemoval,
  settlePreviewAfterSend,
} from './sidebarPreview';
import {
  finalPreview,
  keepOriginals,
  localAttachment,
  localPreview,
  withLocalUrls,
} from './localAttachments';
import { appendLocalSystemLine } from './localSystemLine';
import { PendingOpsBuffer } from './PendingOpsBuffer';
import { ReactionWatch } from './ReactionWatch';
import { ReceiptBuffer } from './ReceiptBuffer';
import type { SentMarkers } from './sentMarkers';
import {
  consoleReporter,
  PASSTHROUGH_PIPELINE,
  type DraftPipeline,
  type ErrorReporter,
  type OutgoingDraft,
} from './types';

/**
 * How a poll vote or end went: `ignored` when there was nothing to do (the
 * poll is unsent, ended, deleted or unknown, the choice isn't one it accepts,
 * or a vote of ours on it is still on its way), `failed` when it was shown
 * and then rolled back because it couldn't be sent.
 */
export type PollActionResult = 'done' | 'ignored' | 'failed';

const log = createLogger('send');

/** Signal clients resend "typing" about every 10 s; more often is noise. */
export const TYPING_REFRESH_MS = 10_000;

/** Shown instead of an opaque "send failed" when an outbox entry's attachment bytes are gone. */
export const ATTACHMENTS_LOST_ERROR = 'attachment lost — re-attach to retry';

/** How many times a sent message's commit is tried before it is only kept in memory. */
const COMMIT_ATTEMPTS = 3;

export interface SendServiceDeps {
  backend: ChatBackend;
  repository: MessageRepository;
  stores: Stores;
  clock: Clock;
  pipeline?: DraftPipeline;
  /** Shared with SyncService so receipts that beat our send's ack aren't lost. */
  receipts?: ReceiptBuffer;
  /** Shared with SyncService so ops that beat our send's ack aren't lost. */
  pendingOps?: PendingOpsBuffer;
  /** Shared with SyncService so a delete that fails knows which reactions were taken back meanwhile. */
  reactionWatch?: ReactionWatch;
  /** Marks a conversation read the way reading it does (receipts and read sync included); sending a reply reads what came before it. */
  readConversation?: (conversationId: ConversationId) => Promise<void>;
  /** A message just sent will disappear at this time (epoch ms): the sync engine purges it on schedule. */
  onExpiry?: (at: number) => void;
  /** A message deleted for the user alone is remembered as gone, so a replay of it does not bring it back (the sync engine's tombstones). */
  rememberPurged?: (id: MessageId) => void;
  /**
   * A send stopped because someone's safety number changed (the message is now
   * `failed` and lists them in `blockedByIdentity`): the app opens the review
   * dialog. Called for sends the user just made or retried, never on restore.
   */
  onIdentityBlocked?: (blocked: {
    conversationId: ConversationId;
    nonce: string;
    contactIds: string[];
  }) => void;
  /** Survives a repository that can't record a send (see `SentMarkers`); optional. */
  sentMarkers?: SentMarkers;
  newNonce?: () => string;
  onError?: ErrorReporter;
}

/**
 * The people a failed send was stopped for because their safety number changed:
 * read structurally off an error that carries `recipientFailures` (the signal-cli
 * adapter's does), so core never names an adapter. Empty for any other failure.
 */
function untrustedRecipients(error: unknown): string[] {
  if (typeof error !== 'object' || error === null || !('recipientFailures' in error)) return [];
  const failures: unknown = error.recipientFailures;
  if (!Array.isArray(failures)) return [];
  const ids = new Set<string>();
  for (const f of failures as unknown[]) {
    if (typeof f !== 'object' || f === null) continue;
    const { recipientId, reason } = f as { recipientId?: unknown; reason?: unknown };
    if (reason === 'untrusted-identity' && typeof recipientId === 'string') ids.add(recipientId);
  }
  return [...ids];
}

/**
 * Whether a send's outcome is unknown: it timed out with no answer, or the
 * request was written and the reply then failed (`requestSent`). The daemon
 * may have sent it, so this is not a plain failure: the error's `outcome` says
 * so. A connection that never opened is a plain failure.
 */
function isUnconfirmedSend(error: unknown): boolean {
  return toAppError(error).outcome === 'maybe-sent';
}

/** A pending row in any state but these was acknowledged by the backend. */
const isAcknowledged = (m: Message): boolean => m.status !== 'pending' && m.status !== 'failed';

export class NotSignedInError extends Error {
  override name = 'NotSignedInError';
}

/** An operation on a message that must wait for its send to be acknowledged. */
interface QueuedOp {
  context: string;
  apply: (m: Message) => Message;
  revert: (m: Message) => Message;
  commit: (target: Message) => Promise<void>;
  /** Note reactions taken back while it is in flight (see `ReactionWatch`). */
  watchReactions?: boolean;
}

interface Outgoing {
  conversationId: ConversationId;
  input: SendInput;
  inFlight: boolean;
  queue: QueuedOp[];
  /** Its conversation was deleted while the send was in flight: nothing is recorded when it lands. */
  abandoned?: boolean;
}

export class SendService {
  private readonly outgoing = new Map<string, Outgoing>();
  private readonly typingSentAt = new Map<ConversationId, number>();
  private readonly pipeline: DraftPipeline;
  private readonly receipts: ReceiptBuffer;
  private readonly pendingOps: PendingOpsBuffer;
  private readonly reactionWatch: ReactionWatch;
  private readonly newNonce: () => string;
  private readonly onError: ErrorReporter;

  constructor(private readonly deps: SendServiceDeps) {
    this.pipeline = deps.pipeline ?? PASSTHROUGH_PIPELINE;
    this.receipts = deps.receipts ?? new ReceiptBuffer();
    this.pendingOps = deps.pendingOps ?? new PendingOpsBuffer();
    this.reactionWatch = deps.reactionWatch ?? new ReactionWatch();
    this.newNonce = deps.newNonce ?? (() => createNonce('msg'));
    this.onError = deps.onError ?? consoleReporter;
  }

  private selfId(): string {
    const self = this.deps.stores.session.getState().self;
    if (!self) throw new NotSignedInError('No account is connected');
    return self.id;
  }

  /**
   * The sender's own *image* custom emoji actually used (as `:name:`) in
   * `body`, deduplicated, for a backend that can deliver them (see
   * the `customEmojiDelivery` feature). A name with no matching local
   * image emoji is simply left out — a text emoticon's token was already
   * expanded to its text by `compose` before `body` ever reached here, and
   * an unknown name renders as plain `:name:` text everywhere, same as it
   * always did.
   */
  private buildCustomEmoji(body: string): OutgoingCustomEmoji[] | undefined {
    if (!this.deps.backend.capabilities.features.has('customEmojiDelivery')) return undefined;
    const library = this.deps.stores.local.getState().customEmoji;
    const used = extractCustomEmojiNames(body)
      .map((name) => library.find((e) => e.name === name))
      .filter((e): e is ImageCustomEmoji => e !== undefined && isImageCustomEmoji(e))
      .map((e) => ({ name: e.name, dataUrl: e.dataUrl }));
    return used.length > 0 ? used : undefined;
  }

  /**
   * Turns composer text into Signal body + ranges: text-emoticon expansion,
   * then markdown (per `format`, or the user's setting when omitted), then
   * mentions.
   *
   * Expansion runs first and unconditionally — a hand-typed `:shrug:` must
   * become `¯\_(ツ)_/¯` whether or not markdown is on — so the length it
   * adds is already in the body before any ranges (markdown spans, mention
   * positions) are computed over it; computing ranges first and shifting
   * them afterwards would be the same result for far more code. When
   * markdown runs next, the expanded text is escaped first so characters
   * inside it (those underscores) can't be read as syntax the user never
   * typed.
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
    const library = this.deps.stores.local.getState().customEmoji;
    const expanded = expandTextEmoticons(text, library, markdown ? escapeMarkdown : undefined);
    const parsed = markdown ? parseMarkdownToRanges(expanded) : { body: expanded, ranges: [] };
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
    // The composer already refuses these; this is the net for the paths that skip it. Nothing is
    // staged, so no row or Blob is stored for a file that can never go out.
    for (const a of transformed.attachments) {
      const problem = attachmentProblem({
        size: a.data.size,
        name: a.fileName,
        type: a.contentType,
      });
      if (problem)
        throw new AppError('user', attachmentProblemMessage(a.fileName, problem), {
          outcome: 'not-sent',
        });
    }

    const { repository, clock } = this.deps;
    const nonce = this.newNonce();
    const now = clock.now();
    const input: SendInput = {
      conversationId: transformed.conversationId,
      body,
      ranges,
      attachments: transformed.attachments,
    };
    if (transformed.quote) input.quote = transformed.quote;
    const customEmoji = this.buildCustomEmoji(body);
    if (customEmoji) input.customEmoji = customEmoji;
    if (transformed.preview) input.preview = transformed.preview;

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
    if (transformed.preview) optimistic.previews = [localPreview(transformed.preview, nonce)];
    await this.stage(nonce, input, optimistic, now);
    return nonce;
  }

  /**
   * Sends a sticker: the message's whole content, so no text pipeline, no
   * markdown and no attachments — only an optional quote. Same optimistic
   * row, outbox entry, status updates and retry as any other send. Resolves
   * with the nonce; never rejects for network errors.
   */
  async sendSticker(request: {
    conversationId: ConversationId;
    sticker: StickerContent;
    quote?: Quote;
  }): Promise<string> {
    const selfId = this.selfId();
    const { repository, clock } = this.deps;
    const nonce = this.newNonce();
    const now = clock.now();
    // Only what the picker knows; never a backup attachment or anything key-shaped.
    const sticker: StickerContent = {
      packId: request.sticker.packId,
      stickerId: request.sticker.stickerId,
      ...(request.sticker.emoji ? { emoji: request.sticker.emoji } : {}),
      ...(request.sticker.url ? { url: request.sticker.url } : {}),
    };
    const input: SendInput = {
      conversationId: request.conversationId,
      body: '',
      ranges: [],
      sticker,
    };
    if (request.quote) input.quote = request.quote;
    const optimistic: Message = {
      id: pendingMessageId(nonce),
      conversationId: input.conversationId,
      authorId: selfId,
      sentAt: now,
      receivedAt: now,
      seq: await repository.allocateSeq(),
      body: '',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'pending',
      kind: 'normal',
      nonce,
      sticker,
    };
    if (input.quote) optimistic.quote = input.quote;
    await this.stage(nonce, input, optimistic, now);
    return nonce;
  }

  /**
   * Sends a poll: the message's whole content, so no text pipeline and no
   * attachments or quote. Same optimistic row, outbox entry, status updates
   * and retry as any other send. Resolves with the nonce, or null when the
   * backend can't take part in polls; throws for a poll that isn't valid
   * (the create dialog never offers one) and never rejects for network errors.
   */
  async sendPoll(request: {
    conversationId: ConversationId;
    poll: OutgoingPoll;
  }): Promise<string | null> {
    if (!this.has('polls')) return null;
    const selfId = this.selfId();
    const poll = tidyPollDraft(request.poll);
    if (pollDraftProblem(poll) !== null) throw new Error("This poll can't be sent.");
    const { repository, clock } = this.deps;
    const nonce = this.newNonce();
    const now = clock.now();
    const input: SendInput = {
      conversationId: request.conversationId,
      body: '',
      ranges: [],
      poll: {
        question: poll.question,
        options: poll.options,
        allowMultiple: request.poll.allowMultiple,
      },
    };
    const optimistic: Message = {
      id: pendingMessageId(nonce),
      conversationId: input.conversationId,
      authorId: selfId,
      sentAt: now,
      receivedAt: now,
      seq: await repository.allocateSeq(),
      body: '',
      ranges: [],
      attachments: [],
      reactions: [],
      status: 'pending',
      kind: 'normal',
      nonce,
      poll: pollOf(input),
    };
    await this.stage(nonce, input, optimistic, now);
    return nonce;
  }

  /** Shows the optimistic row, persists it with its outbox entry, and tries the send. */
  private async stage(
    nonce: string,
    input: SendInput,
    optimistic: Message,
    now: number,
  ): Promise<void> {
    const { repository, stores } = this.deps;
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
    // Writing to someone accepts them, like Signal: signal-cli starts sharing
    // the profile with the first message, so this device must agree.
    stores.local.getState().markAccepted(input.conversationId, now);
    // Writing in an archived chat brings it back to the list.
    stores.local.getState().unarchive(input.conversationId);
    // Row and outbox entry together, or neither: a crash can't orphan one.
    await repository.stageOutgoing(optimistic, { nonce, input, createdAt: now });
    await this.attempt(nonce);
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
      // One entry failing to restore must not stop the others.
      try {
        await this.restoreEntry(entry, selfId);
      } catch (error) {
        this.onError(error, 'restoring an unsent message failed');
      }
    }
    return entries.length;
  }

  private async restoreEntry(entry: OutboxEntry, selfId: string | undefined): Promise<void> {
    const { repository, stores } = this.deps;
    if (this.outgoing.has(entry.nonce)) return;
    const id = pendingMessageId(entry.nonce);
    const conversationId = entry.input.conversationId;
    const failureReason = entry.attachmentsLost ? ATTACHMENTS_LOST_ERROR : undefined;
    // A send the backend acknowledged but whose commit never completed
    // (`recordSentWithoutCommit`) is known from its pending row (no longer
    // pending or failed) or from the marker kept outside the repository. It is
    // never failed (Retry would send it twice): its commit is finished instead.
    const marker = this.deps.sentMarkers?.get(entry.nonce);
    const markRestored = (m: Message): Message => {
      if (isAcknowledged(m)) return m;
      if (marker) {
        return {
          ...m,
          status: 'sent',
          sentAt: marker.sentAt,
          ...(marker.expiresAt === undefined ? {} : { expiresAt: marker.expiresAt }),
        };
      }
      return { ...m, status: 'failed', ...(failureReason ? { failureReason } : {}) };
    };
    const existing = await repository.update(id, markRestored);
    if (existing && isAcknowledged(existing)) {
      if (selfId) await this.completeAcknowledged(entry.nonce, existing, selfId);
      return;
    }
    if (!marker) {
      this.outgoing.set(entry.nonce, {
        conversationId,
        input: entry.input,
        inFlight: false,
        queue: [],
      });
    }
    if (existing) {
      stores.messages.getState().update(conversationId, id, markRestored);
      return;
    }
    if (!selfId) return;
    // Outbox entry without its row (older data, or storage that lost it):
    // rebuild the row from the input so the message is visible and retryable
    // (or, for an acknowledged send, so its commit can be finished).
    const row: Message = {
      id,
      conversationId,
      authorId: selfId,
      sentAt: marker?.sentAt ?? entry.createdAt,
      receivedAt: entry.createdAt,
      seq: await repository.allocateSeq(),
      body: entry.input.body,
      ranges: entry.input.ranges,
      attachments: (entry.input.attachments ?? []).map((a, i) => ({
        id: `${entry.nonce}-${i}`,
        contentType: a.contentType,
        fileName: a.fileName,
        size: a.data.size,
        ...(a.voiceNote ? { voiceNote: true } : {}),
      })),
      reactions: [],
      status: marker ? 'sent' : 'failed',
      kind: 'normal',
      nonce: entry.nonce,
      ...(entry.input.quote ? { quote: entry.input.quote } : {}),
      ...(entry.input.sticker ? { sticker: entry.input.sticker } : {}),
      ...(entry.input.poll ? { poll: pollOf(entry.input) } : {}),
      ...(marker?.expiresAt === undefined ? {} : { expiresAt: marker.expiresAt }),
      ...(failureReason && !marker ? { failureReason } : {}),
    };
    await repository.stageOutgoing(row, entry);
    if (marker) await this.completeAcknowledged(entry.nonce, row, selfId);
    else stores.messages.getState().appendLive(row);
  }

  /**
   * A conversation was deleted: its queued sends are forgotten, and one already
   * on its way is not recorded (nor shown) when the backend answers.
   */
  forgetConversation(conversationId: ConversationId): void {
    for (const [nonce, out] of this.outgoing) {
      if (out.conversationId !== conversationId) continue;
      if (out.inFlight) out.abandoned = true;
      else this.outgoing.delete(nonce);
    }
  }

  /** Completes the commit of a message that was sent but not recorded: no resend, the row becomes the real one. */
  private async completeAcknowledged(nonce: string, row: Message, selfId: string): Promise<void> {
    const { repository, stores } = this.deps;
    const final: Message = { ...row, id: messageId(selfId, row.sentAt), nonce };
    try {
      const { message } = await repository.commitOutgoing(nonce, final, mergeOutgoingCommit);
      stores.messages.getState().reconcile(row.conversationId, nonce, message);
      this.deps.sentMarkers?.clear(nonce);
      if (message.expiresAt !== undefined) this.deps.onExpiry?.(message.expiresAt);
    } catch (error) {
      // The outbox entry stays, so the next start tries again.
      this.onError(error, 'completing a sent message failed');
    }
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
      const setPending = (m: Message): Message => {
        const { blockedByIdentity: _blocked, sendUnconfirmed: _unconfirmed, ...rest } = m;
        return { ...rest, status: 'pending' };
      };
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

  /** Attempts still talking to the backend or recording how they ended. */
  private readonly attempts = new Set<Promise<void>>();

  /**
   * Resolves once every attempt running now has finished and recorded its
   * outcome (stored row and outbox entry). The exit path waits on this, briefly,
   * after aborting in-flight sends so "may have sent" is written before the flush.
   */
  async settled(): Promise<void> {
    while (this.attempts.size > 0) await Promise.allSettled([...this.attempts]);
  }

  private attempt(nonce: string): Promise<void> {
    const running = this.runAttempt(nonce);
    this.attempts.add(running);
    const done = (): void => {
      this.attempts.delete(running);
    };
    running.then(done, done);
    return running;
  }

  private async runAttempt(nonce: string): Promise<void> {
    const out = this.outgoing.get(nonce);
    if (!out) return;
    const { repository, stores, backend, clock } = this.deps;
    const pendingId = pendingMessageId(nonce);
    out.inFlight = true;
    let result;
    // The conversation's timer as it is when the send goes out, which is what the
    // daemon applies (not whatever it becomes while the send is in flight).
    const timer = stores.conversations.getState().byId[out.conversationId]?.expireTimerSec ?? 0;
    try {
      result = await backend.send(out.input);
    } catch (error) {
      out.inFlight = false;
      const blocked = untrustedRecipients(error);
      const unconfirmed = isUnconfirmedSend(error);
      const markFailed = (m: Message): Message => ({
        ...m,
        status: 'failed',
        ...(unconfirmed ? { sendUnconfirmed: true as const } : {}),
        ...(blocked.length > 0 ? { blockedByIdentity: blocked } : {}),
      });
      stores.messages.getState().update(out.conversationId, pendingId, markFailed);
      await repository.update(pendingId, markFailed);
      this.onError(error, 'send failed');
      if (blocked.length > 0)
        this.deps.onIdentityBlocked?.({
          conversationId: out.conversationId,
          nonce,
          contactIds: blocked,
        });
      return;
    }

    if (out.abandoned) {
      this.outgoing.delete(nonce);
      return;
    }
    let stored: Message;
    let built: { final: Message; media: readonly SentMedia[] } | undefined;
    try {
      built = await this.buildFinal(nonce, out, result, timer);
      stored = await this.commitWithRetry(nonce, built.final, built.media);
    } catch (error) {
      await this.recordSentWithoutCommit(nonce, out, result, error, built?.final);
      return;
    }
    this.outgoing.delete(nonce);
    try {
      // A receipt handled while we were committing found no row and was parked; claim it now.
      const late = this.receipts.take(result.sentAt, clock.now());
      if (late !== undefined) {
        stored =
          (await repository.update(stored.id, (m) => {
            const receipts = mergeReceipts(m.receipts, late.recipients);
            return {
              ...m,
              status: advanceStatus(m.status, late.status),
              ...(receipts ? { receipts } : {}),
            };
          })) ?? stored;
      }
      // A delete/reaction/edit/pin that targeted this message before the send
      // was acknowledged (it only has an id to target once the backend echoes
      // or the peer reacts) was parked by SyncService; claim it now.
      const queuedOps = this.pendingOps.take(stored.id, clock.now());
      if (queuedOps.length > 0) {
        stored =
          (await repository.update(stored.id, (m) => queuedOps.reduce((x, op) => op(x), m))) ??
          stored;
      }
      // Re-read right before showing it: receipts applied to the stored row after
      // the commit never reached the store (it still held the pending row).
      stored = (await repository.get(stored.id)) ?? stored;
    } catch (error) {
      // The message is stored and shown as sent; only these extras failed.
      this.onError(error, 'finishing a sent message failed');
    }

    // Show the queued operations' effects straight away; commit them next.
    const shown = out.queue.reduce((m, op) => op.apply(m), stored);
    stores.messages.getState().reconcile(out.conversationId, nonce, shown);
    stores.conversations.getState().noteLatest(shown);
    await settlePreviewAfterSend(stores.conversations, repository, shown).catch(
      ignored('the preview stays as it is'),
    );
    if (stored.expiresAt !== undefined) this.deps.onExpiry?.(stored.expiresAt);
    // Replying means you've seen everything before it. That is a read like
    // any other, so it goes through the read path (which tells the senders
    // and the user's other devices) rather than just moving the cursor.
    // Best effort: a failure here must not keep the queued operations from being sent.
    try {
      if (this.deps.readConversation) {
        await this.deps.readConversation(out.conversationId);
      } else if (
        stored.seq !== undefined &&
        stores.conversations.getState().markRead(out.conversationId, stored.seq)
      ) {
        await repository.setReadCursor(out.conversationId, stored.seq);
      }
    } catch (error) {
      this.onError(error, 'marking the conversation read after sending failed');
    }
    for (const op of out.queue) await this.commitQueued(out.conversationId, stored, op);
  }

  /** The message as it was actually sent (queued edits and reactions are replayed on top). */
  private async buildFinal(
    nonce: string,
    out: Outgoing,
    result: SendResult,
    timer: number,
  ): Promise<{ final: Message; media: readonly SentMedia[] }> {
    const { repository, stores, clock } = this.deps;
    const pendingId = pendingMessageId(nonce);
    const selfId = this.selfId();
    const pendingRow =
      stores.messages.getState().findByNonce(out.conversationId, nonce) ??
      (await repository.get(pendingId));
    // A receipt (and who it was from) may already have arrived for this timestamp.
    const early = this.receipts.take(result.sentAt, clock.now());
    const kept = keepOriginals(
      withLocalUrls(result.attachments, pendingRow?.attachments),
      out.input.attachments ?? [],
      result.attachments !== undefined,
    );
    // What was actually sent — queued edits/reactions are replayed below.
    const final: Message = {
      id: messageId(selfId, result.sentAt),
      conversationId: out.conversationId,
      authorId: selfId,
      sentAt: result.sentAt,
      receivedAt: pendingRow?.receivedAt ?? clock.now(),
      body: out.input.body,
      ranges: out.input.ranges,
      attachments: kept.attachments,
      reactions: [],
      status: advanceStatus('sent', early?.status ?? 'sent'),
      kind: 'normal',
      nonce,
      ...(pendingRow?.seq === undefined ? {} : { seq: pendingRow.seq }),
      ...(out.input.quote ? { quote: out.input.quote } : {}),
      ...(out.input.sticker ? { sticker: out.input.sticker } : {}),
      ...(out.input.poll ? { poll: pollOf(out.input) } : {}),
      ...(result.preview
        ? { previews: [finalPreview(result.preview, pendingRow?.previews?.[0]) ?? result.preview] }
        : {}),
      ...(result.recipientFailures?.length
        ? { failedRecipients: result.recipientFailures.map((f) => f.recipientId) }
        : {}),
      ...(early?.recipients ? { receipts: early.recipients } : {}),
      // The user's own message in a chat with a timer: it runs from the send, as on Desktop.
      ...(timer > 0 ? { expiresAt: result.sentAt + timer * 1000 } : {}),
    };

    return { final, media: kept.media };
  }

  /**
   * Records the acknowledged message in storage, replacing its pending row.
   * The commit is retried a few times: the message has gone out, so this is
   * worth more than giving up on the first storage error.
   */
  private async commitWithRetry(
    nonce: string,
    final: Message,
    media: readonly SentMedia[],
  ): Promise<Message> {
    const { repository } = this.deps;
    let lastError: unknown;
    for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
      try {
        const { message } = await repository.commitOutgoing(
          nonce,
          final,
          mergeOutgoingCommit,
          media,
        );
        return message;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * The backend acknowledged the send but it could not be recorded (storage
   * failed, or the account went away). The message went out, so it is never
   * sent again: it stops being retryable and shows as sent, under its real id
   * (so the phone's sync copy merges with it instead of duplicating it).
   *
   * For the next start, a marker (nonce to `sentAt`) goes to the local
   * key-value storage first, then the sent state, with everything the normal
   * commit keeps (expiry, previews, attachment metadata), onto its pending row
   * if the repository allows. `restoreOutbox` completes the commit from
   * whichever survived. Not carried over: the full-quality copies of sent
   * images (their attachments lose the `original` flag).
   */
  private async recordSentWithoutCommit(
    nonce: string,
    out: Outgoing,
    result: SendResult,
    error: unknown,
    final: Message | undefined,
  ): Promise<void> {
    const { repository, stores, clock } = this.deps;
    const pendingId = pendingMessageId(nonce);
    const { sentAt } = result;
    this.outgoing.delete(nonce);
    out.inFlight = false;
    this.onError(error, 'recording a sent message failed; it will not be sent again');
    try {
      this.deps.sentMarkers?.set(nonce, {
        sentAt,
        ...(final?.expiresAt === undefined ? {} : { expiresAt: final.expiresAt }),
      });
    } catch (error) {
      ignore(error, 'best effort: the pending row below is the other record');
    }
    if (!final) {
      // No account to build the message for: only its state can be shown and kept.
      const markSent = (m: Message): Message => ({ ...m, status: 'sent', sentAt });
      stores.messages.getState().update(out.conversationId, pendingId, markSent);
      for (const op of out.queue) {
        stores.messages.getState().update(out.conversationId, pendingId, op.revert);
        followPreview(stores.conversations, out.conversationId, pendingId, op.revert);
      }
      await repository
        .update(pendingId, markSent)
        .catch(ignored('the storage write failed; the in-memory row is already up to date'));
      if (out.queue.length > 0) {
        this.onError(
          new Error('queued changes were dropped'),
          'a sent message could not be recorded',
        );
      }
      return;
    }
    const { id: _id, ...content } = final;
    const attachments = final.attachments.map(({ original: _original, ...rest }) => rest);
    await repository
      .update(pendingId, (m) => ({ ...m, ...content, attachments }))
      .catch(ignored('the storage write failed; the in-memory row is already up to date'));
    // A receipt that arrived for this timestamp while we were sending.
    const late = this.receipts.take(sentAt, clock.now());
    const receipts = late ? mergeReceipts(final.receipts, late.recipients) : final.receipts;
    const settled: Message = {
      ...final,
      attachments,
      ...(late ? { status: advanceStatus(final.status, late.status) } : {}),
      ...(receipts ? { receipts } : {}),
    };
    const shown = out.queue.reduce((m, op) => op.apply(m), settled);
    stores.messages.getState().reconcile(out.conversationId, nonce, shown);
    stores.conversations.getState().noteLatest(shown);
    await settlePreviewAfterSend(stores.conversations, repository, shown).catch(
      ignored('the preview stays as it is'),
    );
    if (final.expiresAt !== undefined) this.deps.onExpiry?.(final.expiresAt);
    // Queued edits and deletes go out against the real id now.
    for (const op of out.queue) await this.commitQueued(out.conversationId, settled, op);
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
      followPreview(this.deps.stores.conversations, conversationId, target.id, op.revert);
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
    followPreview(this.deps.stores.conversations, conversationId, id, op.apply);
    out.queue.push(op);
    return true;
  }

  // ─── Edit / react / delete ─────────────────────────────────────────────

  private findLoaded(conversationId: ConversationId, id: MessageId): Message | undefined {
    return this.deps.stores.messages.getState().windows[conversationId]?.byId[id];
  }

  /**
   * Edits one of our messages; see the class comment for pending messages.
   *
   * The edit carries the message's link preview, because recipients replace
   * the original's previews with the edit's (as Desktop does): `preview` is a
   * freshly fetched one for a link the edit added, `null` drops it, and when
   * left out the original's own preview goes again for as long as its link is
   * still in the text.
   */
  async edit(
    conversationId: ConversationId,
    id: MessageId,
    text: string,
    mentionIds: readonly string[] = [],
    preview?: OutgoingLinkPreview | null,
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

    // The same limits the UI offers edits under: recipients' clients reject the rest.
    const now = this.deps.clock.now();
    if (!isEditableContent(original, { selfId: this.selfId(), now })) return false;

    const carried = await this.previewForEdit(conversationId, original, body, preview);
    let editedAt = now;
    // What the message shows once edited: the optimistic copy first, the sent one after the commit.
    let previews: LinkPreview[] | undefined = carried?.kept
      ? original.previews
      : carried
        ? [localPreview(carried.send, `${original.sentAt}-${now}`)]
        : undefined;
    return this.operate(conversationId, id, {
      context: 'edit failed',
      apply: (m) => applyEdit(m, { body, ranges, editedAt, ...(previews ? { previews } : {}) }),
      revert: (m) => restoreContent(m, original),
      commit: async (target) => {
        // signal-cli rebuilds the whole data message from the edit's params:
        // without the original quote the edit would drop the reply context.
        const customEmoji = this.buildCustomEmoji(body);
        const result = await this.deps.backend.edit({
          conversationId,
          targetSentAt: target.sentAt,
          body,
          ranges,
          ...(target.quote ? { quote: target.quote } : {}),
          ...(customEmoji ? { customEmoji } : {}),
          ...(carried ? { preview: carried.send } : {}),
        });
        editedAt = result.sentAt;
        if (result.preview && previews && !carried?.kept) {
          previews = [finalPreview(result.preview, previews[0]) ?? result.preview];
        }
      },
    });
  }

  /**
   * The preview an edit of `original` to `body` sends, if any: `preview` when
   * given (and its link is in the text), nothing for `null`, otherwise the
   * original's own while its link remains, rebuilt from the stored copy
   * (`kept`). A message with files carries no preview (Desktop refuses both).
   */
  private async previewForEdit(
    conversationId: ConversationId,
    original: Message,
    body: string,
    preview: OutgoingLinkPreview | null | undefined,
  ): Promise<{ send: OutgoingLinkPreview; kept: boolean } | undefined> {
    if (preview === null || original.attachments.length > 0) return undefined;
    if (preview) return body.includes(preview.url) ? { send: preview, kept: false } : undefined;
    const old = original.previews?.[0];
    if (!old || !body.includes(old.url)) return undefined;
    const send: OutgoingLinkPreview = {
      url: old.url,
      title: old.title ?? old.url,
      ...(old.description ? { description: old.description } : {}),
    };
    // The picture rides along when it can be read; without it the card still goes.
    const { image } = old;
    if (image && this.has('attachmentBlob')) {
      try {
        const data = await this.deps.backend.readAttachmentBlob(conversationId, image);
        send.image = {
          contentType: image.contentType,
          data,
          ...(image.width !== undefined ? { width: image.width } : {}),
          ...(image.height !== undefined ? { height: image.height } : {}),
        };
      } catch (error) {
        ignore(error, 'the preview image is optional; send the title and description only');
      }
    }
    return { send, kept: true };
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
    // Recipients drop a later delete for everyone without a word, so don't send one.
    if (!isWithinDeleteWindow(target, this.deps.clock.now(), this.selfId())) return false;
    return this.operate(conversationId, target.id, {
      context: 'delete failed',
      apply: (m) => applyDelete(m),
      revert: (m) => restoreDeleted(m, target, this.reactionWatch.removed(target.id)),
      watchReactions: true,
      commit: (real) => this.deps.backend.deleteForEveryone(conversationId, real.sentAt),
    });
  }

  /** What the transport supports beyond the required contract (menus hide the rest). */
  get capabilities(): {
    pin: boolean;
    adminDelete: boolean;
    updateConversation: boolean;
    polls: boolean;
  } {
    return {
      pin: this.has('pins'),
      adminDelete: this.has('adminDelete'),
      updateConversation: this.has('conversationSettings'),
      polls: this.has('polls'),
    };
  }

  private has(feature: Feature): boolean {
    return this.deps.backend.capabilities.features.has(feature);
  }

  // ─── Polls ─────────────────────────────────────────────────────────────

  /** Polls with a vote on its way: a second change waits for the first (see `votePoll`). */
  private readonly votingOn = new Set<MessageId>();

  /**
   * Sets our whole answer on a poll (`optionIndexes` is every option we now
   * choose; empty retracts). Shown at once and rolled back, with the error
   * reported in the log, if it can't be sent.
   */
  async votePoll(
    conversationId: ConversationId,
    target: Message,
    optionIndexes: readonly number[],
  ): Promise<PollActionResult> {
    if (!this.has('polls') || isPendingMessageId(target.id) || this.votingOn.has(target.id))
      return 'ignored';
    const selfId = this.selfId();
    // The newest copy: a vote or the end may have landed since `target` was read.
    const latest = this.findLoaded(conversationId, target.id) ?? target;
    const poll = latest.poll;
    if (!poll || latest.deleted || poll.ended === true) return 'ignored';
    const vote: PollVote = {
      voterId: selfId,
      optionIndexes: [...optionIndexes],
      voteCount: nextPollVoteCount(poll, selfId),
      at: this.deps.clock.now(),
    };
    const previous = pollVoteOf(poll, selfId);
    // Nothing to say when it is the answer already given (or no answer, again).
    const chosen = [...vote.optionIndexes].sort((a, b) => a - b);
    const current = [...(previous?.optionIndexes ?? [])].sort((a, b) => a - b);
    if (chosen.length === current.length && chosen.every((index, i) => index === current[i]))
      return 'ignored';
    // The same rules that apply a vote decide whether this one is acceptable.
    if (applyPollVote(latest, vote) === latest) return 'ignored';
    this.votingOn.add(target.id);
    try {
      const sent = await this.optimistic(conversationId, target.id, {
        context: 'vote failed',
        apply: (m) => applyPollVote(m, vote),
        revert: (m) => restorePollVote(m, selfId, previous, vote),
        commit: (real) =>
          this.deps.backend.votePoll({
            conversationId,
            pollAuthorId: real.authorId,
            pollSentAt: real.sentAt,
            optionIndexes: vote.optionIndexes,
            voteCount: vote.voteCount,
          }),
      });
      return sent ? 'done' : 'failed';
    } finally {
      this.votingOn.delete(target.id);
    }
  }

  /**
   * Ends a poll we created: its card turns into final results at once (and
   * back, with the error reported, if the end can't be sent), and the
   * conversation gets Signal's "You ended the poll" line. Only the author can
   * end a poll.
   */
  async endPoll(conversationId: ConversationId, target: Message): Promise<PollActionResult> {
    if (!this.has('polls') || isPendingMessageId(target.id)) return 'ignored';
    const selfId = this.selfId();
    const latest = this.findLoaded(conversationId, target.id) ?? target;
    const poll = latest.poll;
    if (!poll || poll.ended === true || latest.deleted || latest.authorId !== selfId)
      return 'ignored';
    const ended = await this.optimistic(conversationId, target.id, {
      context: 'ending the poll failed',
      apply: applyPollTerminate,
      revert: reopenPoll,
      commit: (real) => this.deps.backend.terminatePoll(conversationId, real.sentAt),
    });
    if (!ended) return 'failed';
    await this.noteEnded(latest, poll.question, selfId);
    return 'done';
  }

  /** The "You ended the poll" line, after the end went out. */
  private async noteEnded(poll: Message, question: string, selfId: string): Promise<void> {
    await appendLocalSystemLine(this.deps, {
      conversationId: poll.conversationId,
      authorId: selfId,
      text: pollEndedText('You', question),
      tag: 'poll-end',
    });
  }

  /** Pins or unpins a message for everyone, when the transport supports pins. */
  async pin(conversationId: ConversationId, target: Message, pin: boolean): Promise<boolean> {
    if (!this.has('pins') || target.deleted || target.kind !== 'normal') return false;
    const set =
      (value: boolean) =>
      (m: Message): Message => {
        const { pinned: _pinned, ...rest } = m;
        return value ? { ...rest, pinned: true } : rest;
      };
    const done = await this.operate(conversationId, target.id, {
      context: pin ? 'pin failed' : 'unpin failed',
      apply: set(pin),
      revert: set(target.pinned === true),
      commit: (real) =>
        this.deps.backend.pinMessage({
          conversationId,
          targetAuthorId: real.authorId,
          targetSentAt: real.sentAt,
          pin,
        }),
    });
    if (done && pin) await this.notePinned(conversationId, target);
    return done;
  }

  /** The "You pinned a message" line, with its button to the message, after the pin went out. */
  private async notePinned(conversationId: ConversationId, target: Message): Promise<void> {
    if (isPendingMessageId(target.id)) return;
    try {
      await appendLocalSystemLine(this.deps, {
        conversationId,
        authorId: this.selfId(),
        text: pinnedText('You'),
        tag: 'pin',
        action: { kind: 'go-to-message', messageId: target.id },
      });
    } catch (error) {
      this.onError(error, 'noting a pin failed');
    }
  }

  /** A group admin deleting someone else's message, when the transport supports it. */
  async adminDelete(conversationId: ConversationId, target: Message): Promise<boolean> {
    if (!this.has('adminDelete') || target.deleted || isPendingMessageId(target.id)) return false;
    const selfId = this.selfId();
    if (!isWithinDeleteWindow(target, this.deps.clock.now(), selfId)) return false;
    return this.optimistic(conversationId, target.id, {
      context: 'delete failed',
      apply: (m) => applyDelete(m, selfId),
      revert: (m) => restoreDeleted(m, target, this.reactionWatch.removed(target.id)),
      watchReactions: true,
      commit: (real) =>
        this.deps.backend.adminDelete(conversationId, {
          authorId: real.authorId,
          sentAt: real.sentAt,
        }),
    });
  }

  /**
   * Removes a message from this device only. Unsent messages are discarded
   * (nothing to keep); everything else is dropped from history and the view,
   * and then removed on the user's other devices too (see `syncDeleteForMe`).
   * The removal here is immediate and does not wait for that.
   */
  async deleteForMe(conversationId: ConversationId, target: Message): Promise<void> {
    const nonce = target.nonce;
    if (nonce !== undefined && isPendingMessageId(target.id) && this.outgoing.has(nonce)) {
      await this.discard(conversationId, nonce);
      return;
    }
    this.deps.stores.messages.getState().remove(conversationId, target.id);
    this.deps.rememberPurged?.(target.id);
    // A message nobody read leaves the unread count with it (else the chat keeps a ghost unread).
    const selfId = this.deps.stores.session.getState().self?.id;
    if (selfId) this.deps.stores.conversations.getState().applyRemoval(target, selfId);
    await this.deps.repository.delete(target.id);
    await refreshPreviewAfterRemoval(
      this.deps.stores.conversations,
      this.deps.repository,
      conversationId,
      target,
    );
    void this.syncDeleteForMe(conversationId, target);
  }

  /**
   * Tells the user's other devices a message was removed here, for a backend
   * that can (`deleteSync`). Only a message that was sent (an unsent one only
   * ever existed here) and a real one (not a system line). A background step
   * after the local delete: a failure never brings the message back and is
   * never shown to the user, only logged with its kind (no ids, no content).
   * Each call syncs its own message.
   */
  private async syncDeleteForMe(conversationId: ConversationId, target: Message): Promise<void> {
    if (!this.has('deleteSync') || isPendingMessageId(target.id) || target.kind !== 'normal')
      return;
    try {
      await this.deps.backend.syncDeleteForMe(conversationId, [
        { authorId: target.authorId, sentAt: target.sentAt },
      ]);
    } catch (error) {
      log.warn('delete sync failed', { kind: toAppError(error).kind });
    }
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
    if (!this.has('conversationSettings')) return false;
    try {
      await this.deps.backend.updateConversation(conversationId, patch);
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
    // The phone's typing-indicator setting wins when known; until the first
    // read from it has finished nothing is sent (see `effectivePrivacy`).
    const { settings, session } = this.deps.stores;
    // A message request hears nothing from the user until it is accepted.
    const allowed =
      effectivePrivacy(settings.getState().behaviour, session.getState().phonePrivacy)
        .sendTypingIndicators &&
      selectMessageRequestState(this.deps.stores, conversationId) === 'accepted' &&
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
    followPreview(this.deps.stores.conversations, conversationId, id, op.apply);
    if (op.watchReactions) this.reactionWatch.begin(id);
    try {
      await op.commit(target);
    } catch (error) {
      this.deps.stores.messages.getState().update(conversationId, id, op.revert);
      followPreview(this.deps.stores.conversations, conversationId, id, op.revert);
      this.reactionWatch.end(id);
      this.onError(error, op.context);
      return false;
    }
    this.reactionWatch.end(id);
    await this.deps.repository.update(id, op.apply);
    return true;
  }
}

/** The poll a send of `input.poll` shows before anyone has voted. */
function pollOf(input: SendInput): NonNullable<Message['poll']> {
  const poll = input.poll;
  if (!poll) throw new Error('Not a poll send');
  return {
    question: poll.question,
    options: [...poll.options],
    allowMultiple: poll.allowMultiple,
    votes: [],
  };
}

/** Puts an original message's content fields back, including absent optionals. */
function restoreContent(m: Message, original: Message): Message {
  const { edits: _e, editedAt: _t, previews: _p, ...rest } = m;
  return {
    ...rest,
    body: original.body,
    ranges: original.ranges,
    ...(original.edits === undefined ? {} : { edits: original.edits }),
    ...(original.editedAt === undefined ? {} : { editedAt: original.editedAt }),
    ...(original.previews ? { previews: original.previews } : {}),
  };
}

/**
 * Undoes `applyDelete` on the message as it is now: the content the delete
 * took away comes back, and everything that changed meanwhile (receipts,
 * status, reactions that arrived) stays.
 */
function restoreDeleted(m: Message, original: Message, takenBack: ReadonlySet<string>): Message {
  const { deleted: _d, deletedBy: _by, ...rest } = m;
  const arrived = new Set([...m.reactions.map((r) => r.authorId), ...takenBack]);
  return {
    ...rest,
    body: original.body,
    ranges: original.ranges,
    attachments: original.attachments,
    reactions: [...original.reactions.filter((r) => !arrived.has(r.authorId)), ...m.reactions],
    ...(original.quote ? { quote: original.quote } : {}),
    ...(original.pinned === undefined ? {} : { pinned: original.pinned }),
    ...(original.sticker ? { sticker: original.sticker } : {}),
    ...(original.poll ? { poll: original.poll } : {}),
    ...(original.previews ? { previews: original.previews } : {}),
    ...(original.customEmoji ? { customEmoji: original.customEmoji } : {}),
    ...(original.failedRecipients ? { failedRecipients: original.failedRecipients } : {}),
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
