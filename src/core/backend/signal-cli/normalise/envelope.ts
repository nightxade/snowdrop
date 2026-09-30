/**
 * signal-cli envelope → adapter events. Pure: same input, same output.
 *
 * One envelope carries at most one "thing" (a data message, an edit, a sync
 * transcript, a receipt, a typing indicator…), and a data message is either
 * an action on another message (reaction, delete, pin) or visible content.
 * Anything unknown or unsupported (calls, stories, poll votes) is skipped
 * with a debug log — never an exception.
 */
import {
  directConversationId,
  formatDuration,
  groupConversationId,
  type ConversationId,
  type MessageStatus,
} from '@/core/domain';
import type { ReceiptType } from '../../types';
import { decode } from '../validate';
import {
  addressId,
  wireReceive,
  type WireDataMessage,
  type WireEditMessage,
  type WireEnvelope,
} from '../wire';
import { buildMessage, systemMessage } from './content';
import { toBodyRanges } from './ranges';
import type { AdapterEvent, NormaliseContext } from './types';

/** Typing indicators older than this are dropped (Signal clients expire them after 15 s). */
export const TYPING_STALE_MS = 15_000;

/** Who sent the data message and where it belongs. */
interface Origin {
  authorId: string;
  conversationId: ConversationId;
  /** Our own message from another linked device (sync transcript). */
  own: boolean;
  /** Human name of the author for system texts. */
  actorName: string;
}

/**
 * Parses one SSE `receive` payload (already JSON-decoded) into events.
 * Returns [] for anything we can't or needn't represent.
 */
export function normaliseReceive(payload: unknown, ctx: NormaliseContext): AdapterEvent[] {
  const decoded = decode(wireReceive, payload);
  if (!decoded.ok) {
    ctx.debug('ignored malformed receive payload', decoded.error.message);
    return [];
  }
  if (decoded.issues.length > 0) ctx.debug('lenient decode issues', decoded.issues);
  const { envelope, exception } = decoded.value;
  if (exception) ctx.debug('daemon reported a receive exception', exception);
  if (!envelope) return [];
  return normaliseEnvelope(envelope, ctx);
}

export function normaliseEnvelope(envelope: WireEnvelope, ctx: NormaliseContext): AdapterEvent[] {
  const rawSource = addressId(envelope.sourceUuid, envelope.sourceNumber, envelope.source);
  if (!rawSource) {
    ctx.debug('ignored envelope without a source', envelope.timestamp);
    return [];
  }
  const resolve = (id: string): string => (ctx.selfAliases.has(id) ? ctx.selfId : id);
  const source = resolve(rawSource);
  const nameOf = (id: string, fallback?: string): string =>
    id === ctx.selfId ? 'You' : (ctx.nameOf(id) ?? fallback ?? id);

  if (envelope.receiptMessage) {
    const r = envelope.receiptMessage;
    const type: ReceiptType | undefined = r.isRead
      ? 'read'
      : r.isViewed
        ? 'viewed'
        : r.isDelivery
          ? 'delivered'
          : undefined;
    if (!type || r.timestamps.length === 0) return [];
    return [{ kind: 'receipt', payload: { authorId: source, sentAts: r.timestamps, type } }];
  }

  if (envelope.typingMessage) {
    const t = envelope.typingMessage;
    if (source === ctx.selfId) return [];
    // Typing is ephemeral: a replay after reconnect (the daemon re-sends up to
    // 1000 buffered events) must not show people typing minutes ago. The
    // server timestamp is immune to the sender's clock skew.
    const at = envelope.serverReceivedTimestamp ?? t.timestamp ?? envelope.timestamp;
    if (ctx.now - at > TYPING_STALE_MS) return [];
    const conversationId = t.groupId
      ? groupConversationId(t.groupId)
      : directConversationId(source);
    return [
      {
        kind: 'typing',
        payload: { conversationId, authorId: source, typing: t.action.toUpperCase() === 'STARTED' },
      },
    ];
  }

  if (envelope.syncMessage) {
    const sync = envelope.syncMessage;
    const events: AdapterEvent[] = [];
    const sent = sync.sentMessage;
    if (sent) {
      const destination = addressId(sent.destinationUuid, sent.destinationNumber, sent.destination);
      // No destination and no group ⇒ note to self.
      const peer = destination ? resolve(destination) : ctx.selfId;
      const dataOrEdit = sent.dataMessage ?? sent.editMessage?.dataMessage;
      const groupId = dataOrEdit?.groupInfo?.groupId;
      const origin: Origin = {
        authorId: ctx.selfId,
        conversationId: groupId ? groupConversationId(groupId) : directConversationId(peer),
        own: true,
        actorName: 'You',
      };
      if (sent.editMessage) events.push(...fromEdit(sent.editMessage, origin, resolve));
      if (sent.dataMessage)
        events.push(...fromData(sent.dataMessage, origin, ctx, resolve, nameOf));
    }
    if (sync.readMessages.length > 0) {
      events.push({
        kind: 'readSync',
        payload: {
          messages: sync.readMessages.flatMap((r) => {
            const author = addressId(r.senderUuid, r.senderNumber, r.sender);
            return author ? [{ authorId: resolve(author), sentAt: r.timestamp }] : [];
          }),
        },
      });
    }
    if (
      sync.type === 'CONTACTS_SYNC' ||
      sync.blockedNumbers.length > 0 ||
      sync.blockedGroupIds.length > 0
    ) {
      events.push({ kind: 'contactsChanged' });
    }
    if (events.length === 0) ctx.debug('ignored sync message', Object.keys(sync));
    return events;
  }

  const data = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
  if (data) {
    const groupId = data.groupInfo?.groupId;
    const origin: Origin = {
      authorId: source,
      conversationId: groupId ? groupConversationId(groupId) : directConversationId(source),
      own: source === ctx.selfId,
      actorName: nameOf(source, envelope.sourceName),
    };
    if (envelope.editMessage) return fromEdit(envelope.editMessage, origin, resolve);
    return fromData(data, origin, ctx, resolve, nameOf);
  }

  if (envelope.callMessage !== undefined) ctx.debug('ignored call message');
  else if (envelope.storyMessage !== undefined) ctx.debug('ignored story');
  else ctx.debug('ignored empty envelope', envelope.timestamp);
  return [];
}

function fromEdit(
  edit: WireEditMessage,
  origin: Origin,
  resolve: (id: string) => string,
): AdapterEvent[] {
  const data = edit.dataMessage;
  const body = data.message ?? '';
  const ranges = toBodyRanges(body, data.textStyles, data.mentions).map((r) =>
    r.mentionId === undefined ? r : { ...r, mentionId: resolve(r.mentionId) },
  );
  return [
    {
      kind: 'messageEdited',
      payload: {
        conversationId: origin.conversationId,
        authorId: origin.authorId,
        targetSentAt: edit.targetSentTimestamp,
        body,
        ranges,
        editedAt: data.timestamp,
      },
    },
  ];
}

function fromData(
  data: WireDataMessage,
  origin: Origin,
  ctx: NormaliseContext,
  resolve: (id: string) => string,
  nameOf: (id: string, fallback?: string) => string,
): AdapterEvent[] {
  const { conversationId, authorId } = origin;
  const target = (t: {
    targetAuthor: string | undefined;
    targetAuthorNumber: string | undefined;
    targetAuthorUuid: string | undefined;
  }): string | undefined => {
    const id = addressId(t.targetAuthorUuid, t.targetAuthorNumber, t.targetAuthor);
    return id === undefined ? undefined : resolve(id);
  };

  if (data.reaction) {
    const r = data.reaction;
    const targetAuthorId = target(r);
    if (!targetAuthorId) return [];
    return [
      {
        kind: 'reaction',
        payload: {
          conversationId,
          targetAuthorId,
          targetSentAt: r.targetSentTimestamp,
          reaction: { emoji: r.emoji, authorId, at: data.timestamp },
          remove: r.isRemove,
        },
      },
    ];
  }

  if (data.remoteDelete) {
    return [
      {
        kind: 'messageDeleted',
        payload: { conversationId, authorId, targetSentAt: data.remoteDelete.timestamp },
      },
    ];
  }

  if (data.adminDelete) {
    const targetAuthorId = target(data.adminDelete);
    if (!targetAuthorId) return [];
    return [
      {
        kind: 'messageDeleted',
        payload: {
          conversationId,
          authorId: targetAuthorId,
          targetSentAt: data.adminDelete.targetSentTimestamp,
          deletedBy: authorId,
        },
      },
    ];
  }

  const pin = data.pinMessage ?? data.unpinMessage;
  if (pin) {
    const targetAuthorId = target(pin);
    if (!targetAuthorId) return [];
    return [
      {
        kind: 'messagePinned',
        payload: {
          conversationId,
          targetAuthorId,
          targetSentAt: pin.targetSentTimestamp,
          pinned: data.pinMessage !== undefined,
          by: authorId,
        },
      },
    ];
  }

  if (data.pollVote !== undefined || data.pollTerminate !== undefined) {
    ctx.debug('ignored poll vote/terminate', data.timestamp);
    return [];
  }

  const events: AdapterEvent[] = [];
  const meta = { conversationId, authorId, receivedAt: ctx.now };

  if (data.groupInfo?.type === 'UPDATE') {
    // What changed (title, members, timer…) is only knowable by re-listing
    // the group; the backend diffs and writes the system line. Emitting a
    // timer line here too would collide on the same (author, sentAt) id.
    events.push({
      kind: 'groupChanged',
      groupId: data.groupInfo.groupId,
      conversationId,
      actorId: authorId,
      sentAt: data.timestamp,
    });
    const hasContent =
      (data.message ?? '') !== '' || data.attachments.length > 0 || data.quote !== undefined;
    if (!hasContent) return events;
  } else if (data.isExpirationUpdate) {
    const seconds = data.expiresInSeconds ?? 0;
    events.push({ kind: 'expirationChanged', conversationId, seconds });
    const text =
      seconds > 0
        ? `${origin.actorName} set disappearing messages to ${formatDuration(seconds)}.`
        : `${origin.actorName} turned off disappearing messages.`;
    events.push({ kind: 'message', payload: systemMessage(meta, data.timestamp, text) });
    // Expiration updates carry no content of their own.
    return events;
  }

  if (data.groupCallUpdate !== undefined) {
    const text = `${nameOf(authorId, origin.actorName)} started a group call.`;
    events.push({ kind: 'message', payload: systemMessage(meta, data.timestamp, text) });
    return events;
  }

  const status: MessageStatus = origin.own ? 'sent' : 'read';
  const message = buildMessage(data, { ...meta, status, resolveId: resolve });
  if (message) events.push({ kind: 'message', payload: message });
  else if (events.length === 0) ctx.debug('ignored data message without content', data.timestamp);
  return events;
}
