/**
 * Domain inputs → signal-cli JSON-RPC params, and send results → domain.
 *
 * Param names are the CLI flags in camelCase (`--quote-timestamp` →
 * `quoteTimestamp`); multi-value flags accept arrays under the singular name.
 */
import { PROFILE_LIMITS, parseConversationId, type ConversationId } from '@/core/domain';
import { graphemes, pollDraftProblem, tidyPollDraft, utf8Length } from '@/core/lib';
import type {
  OutgoingPoll,
  PollVoteInput,
  ProfileUpdate,
  ReadSummary,
  RecipientFailure,
  RecipientFailureReason,
  SendInput,
} from '../types';
import { SignalCliError } from './errors';
import { mentionParams, textStyleParams } from './normalise/ranges';
import type { RpcParams } from './rpc';
import { decode, isRecord } from './validate';
import { addressId, wireReceiptReply, wireSendResult, type WireSendResult } from './wire';

/** Where a conversation's messages go: `recipient`, `groupId`, or note-to-self. */
export function targetParams(
  conversationId: ConversationId,
  selfAliases: ReadonlySet<string>,
): RpcParams {
  const parsed = parseConversationId(conversationId);
  if (!parsed) {
    throw new SignalCliError('user', `Not a conversation id: ${conversationId}`);
  }
  if (parsed.kind === 'group') return { groupId: parsed.target };
  // Sending to our own address must be a note-to-self, or signal-cli sends a
  // regular message to our other devices only.
  if (selfAliases.has(parsed.target)) return { noteToSelf: true };
  return { recipient: [parsed.target] };
}

/**
 * RFC 2397 data URI with signal-cli's `filename` parameter. The filename is
 * URL-encoded because signal-cli URL-decodes parameter values (and `;`/`,`
 * would otherwise break the URI).
 */
export function toDataUri(contentType: string, fileName: string, base64: string): string {
  // signal-cli treats anything that fails its data-URI pattern (which needs
  // at least one data character) as a *file path on the daemon host*. Never
  // let an empty payload fall through to that.
  if (base64.length === 0) throw new SignalCliError('user', "Empty files can't be sent.");
  // The media type must look like type/subtype and contain no parameters.
  const type = /^[\w.+-]+\/[\w.+-]+$/u.test(contentType) ? contentType : 'application/octet-stream';
  return `data:${type};filename=${encodeURIComponent(fileName || 'file')};base64,${base64}`;
}

function checkProfileField(text: string, limit: { graphemes: number; bytes: number }): void {
  if (graphemes(text).length > limit.graphemes || utf8Length(text) > limit.bytes) {
    throw new SignalCliError('user', 'That profile text is too long.');
  }
}

/**
 * `updateProfile` params. Every text field is always sent, so clearing one
 * works; the photo is sent only when it changes. Limits are Signal Desktop's,
 * checked here as well so nothing over them reaches the server.
 */
export function profileParams(update: ProfileUpdate): RpcParams {
  const givenName = update.givenName.trim();
  if (!givenName) throw new SignalCliError('user', 'A first name is required.');
  const familyName = update.familyName.trim();
  checkProfileField(givenName, PROFILE_LIMITS.name);
  checkProfileField(familyName, PROFILE_LIMITS.name);
  checkProfileField(update.about, PROFILE_LIMITS.about);
  // The emoji is one character; the same cap keeps a pasted string out.
  checkProfileField(update.aboutEmoji, { graphemes: 1, bytes: 32 });
  const params: RpcParams = {
    givenName,
    familyName,
    about: update.about,
    aboutEmoji: update.aboutEmoji,
  };
  if (update.avatar === null) params.removeAvatar = true;
  else if (update.avatar) {
    params.avatar = toDataUri(update.avatar.contentType, 'avatar', update.avatar.base64);
  }
  return params;
}

export interface MessageParamsInput {
  body: string;
  ranges: SendInput['ranges'];
  quote?: SendInput['quote'];
  /** Data URIs, already encoded. */
  attachments?: string[];
  /** Makes this an edit of the message sent at this timestamp. */
  editTimestamp?: number;
  /** Custom emoji used in `body`, for a daemon that can deliver them (patches/signal-cli). */
  customEmoji?: SendInput['customEmoji'];
  /** The link preview to attach; `image`, if any, is already a data URI. */
  preview?: { url: string; title: string; description?: string; image?: string };
  /** `packIdHex:stickerId` (see `stickerParam`). */
  sticker?: string;
}

export function messageParams(input: MessageParamsInput): RpcParams {
  const params: RpcParams = { message: input.body };
  const styles = textStyleParams(input.ranges);
  const mentions = mentionParams(input.ranges);
  if (styles.length > 0) params.textStyle = styles;
  if (mentions.length > 0) params.mention = mentions;
  if (input.attachments && input.attachments.length > 0) params.attachment = input.attachments;
  if (input.editTimestamp !== undefined) params.editTimestamp = input.editTimestamp;
  if (input.sticker !== undefined) params.sticker = input.sticker;
  if (input.preview) {
    params.previewUrl = input.preview.url;
    // signal-cli's `SendCommand` treats a missing title as "" rather than
    // rejecting the send, but an empty preview card helps nobody.
    params.previewTitle = input.preview.title || input.preview.url;
    if (input.preview.description) params.previewDescription = input.preview.description;
    if (input.preview.image) params.previewImage = input.preview.image;
  }
  if (input.customEmoji && input.customEmoji.length > 0) {
    params.customEmoji = input.customEmoji.map((e) => ({ name: e.name, attachment: e.dataUrl }));
  }
  const quote = input.quote;
  if (quote) {
    params.quoteTimestamp = quote.sentAt;
    params.quoteAuthor = quote.authorId;
    params.quoteMessage = quote.text;
    const qRanges = quote.ranges ?? [];
    const qStyles = textStyleParams(qRanges);
    const qMentions = mentionParams(qRanges);
    if (qStyles.length > 0) params.quoteTextStyle = qStyles;
    if (qMentions.length > 0) params.quoteMention = qMentions;
    const qAttachments = quoteAttachmentParams(quote.attachments ?? []);
    if (qAttachments.length > 0) params.quoteAttachment = qAttachments;
  }
  return params;
}

/**
 * `sendPollCreate` params: the question and options (re-checked here, so
 * nothing signal-cli would refuse reaches it), and `noMulti` for a
 * single-choice poll.
 */
export function pollCreateParams(poll: OutgoingPoll): RpcParams {
  const tidy = tidyPollDraft(poll);
  if (pollDraftProblem(tidy) !== null) throw new SignalCliError('user', "This poll can't be sent.");
  const params: RpcParams = { question: tidy.question, option: tidy.options };
  if (!poll.allowMultiple) params.noMulti = true;
  return params;
}

/**
 * `sendPollVote` params. The option list is always sent, even when empty
 * (a retracted vote). Signal numbers options 0 to 9 and counts votes from 1.
 */
export function pollVoteParams(input: PollVoteInput): RpcParams {
  const valid =
    input.optionIndexes.every((i) => Number.isInteger(i) && i >= 0 && i <= 9) &&
    new Set(input.optionIndexes).size === input.optionIndexes.length &&
    Number.isSafeInteger(input.pollSentAt) &&
    input.pollSentAt > 0 &&
    Number.isInteger(input.voteCount) &&
    input.voteCount >= 1 &&
    input.voteCount <= 2_147_483_647;
  if (!valid) throw new SignalCliError('user', "This vote can't be sent.");
  return {
    pollAuthor: input.pollAuthorId,
    pollTimestamp: input.pollSentAt,
    option: input.optionIndexes,
    voteCount: input.voteCount,
  };
}

/**
 * signal-cli's `--sticker` syntax, `packIdHex:stickerId`. Validated here so a
 * malformed pair fails as a clean error instead of a daemon parse failure
 * (which would echo it back).
 */
export function stickerParam(packId: string, stickerId: number): string {
  if (!/^[\da-f]+$/u.test(packId) || !Number.isSafeInteger(stickerId) || stickerId < 0)
    throw new Error('Invalid sticker');
  return `${packId}:${stickerId}`;
}

/**
 * `quoteAttachment`: `contentType[:filename]`. The CLI syntax splits on `:`
 * (a third part would be a *preview file path*), so colons in names are
 * replaced and types that aren't plain type/subtype are skipped.
 */
export function quoteAttachmentParams(
  attachments: readonly { contentType: string; fileName?: string }[],
): string[] {
  return attachments.flatMap((a) => {
    if (!/^[\w.+-]+\/[\w.+-]+$/u.test(a.contentType)) return [];
    const name = a.fileName?.replaceAll(':', '_');
    return [name ? `${a.contentType}:${name}` : a.contentType];
  });
}

/** Pin durations are Java ints on the daemon side; -1 means "forever". */
export function pinDurationParam(seconds: number | undefined): number {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return -1;
  return Math.min(Math.trunc(seconds), 2_147_483_647) || 1;
}

const FAILURE_REASONS: Record<string, RecipientFailureReason> = {
  NETWORK_FAILURE: 'network',
  UNREGISTERED_FAILURE: 'unregistered',
  IDENTITY_FAILURE: 'untrusted-identity',
  RATE_LIMIT_FAILURE: 'rate-limited',
};

/**
 * What happened to one receipt: `success`, or the failure's reason (the same names `send` reports
 * for a recipient). Types only: nothing here identifies a person or a message.
 */
export function receiptOutcome(type: string): 'success' | RecipientFailureReason {
  return type === 'SUCCESS' ? 'success' : (FAILURE_REASONS[type] ?? 'unknown');
}

/**
 * The summary of one `markRead` call from its `sendReceipt` replies (one per author; a reply that
 * can't be read counts as one without results or sync field). `receipt` is `none` when no
 * receipt went out, `success`, or the first failure; `sync` is `none` when nothing was sent,
 * `unreported` when signal-cli didn't say (older build), `success`, or the first non-success.
 */
export function summariseReadReplies(replies: readonly unknown[]): ReadSummary {
  const receipts: string[] = [];
  const syncs: string[] = [];
  for (const raw of replies) {
    const decoded = decode(wireReceiptReply, raw);
    if (!decoded.ok) {
      syncs.push('unreported');
      continue;
    }
    for (const item of decoded.value.results) receipts.push(receiptOutcome(item.type));
    syncs.push(decoded.value.sync ?? 'unreported');
  }
  const receipt =
    receipts.find((r) => r !== 'success') ?? (receipts.length > 0 ? 'success' : 'none');
  const sync =
    syncs.find((s) => s !== 'success' && s !== 'unreported') ??
    (syncs.includes('unreported') ? 'unreported' : syncs.length > 0 ? 'success' : 'none');
  return { receipt, sync };
}

export function recipientFailures(result: WireSendResult): RecipientFailure[] {
  return result.results.flatMap((r) => {
    if (r.type === 'SUCCESS') return [];
    const id = addressId(r.recipientAddress?.uuid, r.recipientAddress?.number);
    if (!id) return [];
    return [{ recipientId: id, reason: FAILURE_REASONS[r.type] ?? 'unknown' }];
  });
}

/**
 * When a send reaches nobody signal-cli answers with an RPC error whose
 * `data.response` holds the per-recipient results; surface them as a typed
 * `send-failed` error so the UI can say *why* (e.g. "not on Signal").
 */
export function enrichSendError(error: unknown): unknown {
  if (!(error instanceof SignalCliError) || !isRecord(error.data)) return error;
  const decoded = decode(wireSendResult, error.data.response);
  if (!decoded.ok) return error;
  const failures = recipientFailures(decoded.value);
  if (failures.length === 0) return error;
  const retryAfter = decoded.value.results.find((r) => r.retryAfterSeconds !== undefined);
  return new SignalCliError('send-failed', error.message, {
    ...(error.code === undefined ? {} : { code: error.code }),
    data: error.data,
    recipientFailures: failures,
    ...(retryAfter?.retryAfterSeconds === undefined
      ? {}
      : { retryAfterSec: retryAfter.retryAfterSeconds }),
    cause: error,
  });
}
