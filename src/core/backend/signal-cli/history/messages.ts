import {
  MAX_BODY_RANGES,
  messageId,
  systemMessageId,
  TEXT_STYLES,
  type Attachment,
  type BodyRange,
  type LinkPreview,
  type Message,
  type MessageStatus,
  type PollContent,
  type PollVote,
  type Quote,
  type Reaction,
  type TextStyle,
} from '@/core/domain';
import { isRecord } from '../validate';
import { backupUuid, type BackupDirectory } from './directory';
import { additionalContent, clean } from './content';
import { decimal, record, records, text, timestamp, uint32, type BackupRecord } from './wire';

function bodyRanges(value: BackupRecord): BodyRange[] {
  const body = text(value.body);
  const out = records(value.bodyRanges).flatMap((range): BodyRange[] => {
    const start = uint32(range.start ?? 0);
    const length = uint32(range.length);
    if (start === undefined || !length || start + length > body.length) return [];
    const mentionId = backupUuid(range.mentionAci);
    if (mentionId) return [{ start, length, mentionId }];
    const style = text(range.style).toLowerCase() as TextStyle;
    return TEXT_STYLES.includes(style) ? [{ start, length, style }] : [];
  });
  // Mentions first, like live messages: a hostile archive can't push them out.
  const mentions = out.filter((r) => r.mentionId !== undefined);
  const styles = out.filter((r) => r.mentionId === undefined);
  return out.length <= MAX_BODY_RANGES
    ? out
    : [...mentions, ...styles]
        .slice(0, MAX_BODY_RANGES)
        .sort((a, b) => a.start - b.start || b.length - a.length);
}

function reactions(value: unknown, directory: BackupDirectory): Reaction[] {
  return records(value).flatMap((reaction) => {
    const authorId = directory.author(decimal(reaction.authorId));
    const emoji = text(reaction.emoji);
    return authorId && emoji ? [{ authorId, emoji, at: timestamp(reaction.sentTimestamp) }] : [];
  });
}

function quote(value: unknown, directory: BackupDirectory): Quote | undefined {
  if (!isRecord(value) || value.targetSentTimestamp === undefined) return undefined;
  const authorId = directory.author(decimal(value.authorId));
  if (!authorId) return undefined;
  const body = record(value.text);
  // View-once quotes must never expose thumbnails or captions from old archives.
  if (value.type === 'VIEW_ONCE') {
    return { authorId, sentAt: timestamp(value.targetSentTimestamp), text: 'View-once media' };
  }
  return {
    authorId,
    sentAt: timestamp(value.targetSentTimestamp),
    text: text(body.body),
    ranges: bodyRanges(body),
    attachments: records(value.attachments).map((attachment) => ({
      contentType: text(attachment.contentType) || 'application/octet-stream',
      ...(text(attachment.fileName) ? { fileName: text(attachment.fileName) } : {}),
    })),
  };
}

/** Only display metadata crosses into the domain; download keys stay in signal-cli. */
function attachment(pointer: BackupRecord, id: string): Attachment {
  const result: Attachment = {
    id,
    contentType: text(pointer.contentType) || 'application/octet-stream',
  };
  if (text(pointer.fileName)) result.fileName = text(pointer.fileName);
  if (text(pointer.blurHash)) result.blurhash = text(pointer.blurHash);
  const size = uint32(record(pointer.locatorInfo).size);
  const width = uint32(pointer.width);
  const height = uint32(pointer.height);
  if (size !== undefined) result.size = size;
  if (width) result.width = width;
  if (height) result.height = height;
  return result;
}

/** `StandardMessage.linkPreview` (Backups.proto): url, title?, image? (FilePointer), description?. */
function linkPreviews(value: unknown, archiveId: string, cursor: string): LinkPreview[] {
  return records(value).flatMap((entry, index): LinkPreview[] => {
    const url = text(entry.url);
    if (!url) return [];
    const preview: LinkPreview = { url };
    if (text(entry.title)) preview.title = text(entry.title);
    if (text(entry.description)) preview.description = text(entry.description);
    if (isRecord(entry.image)) {
      preview.image = attachment(entry.image, `history:${archiveId}:${cursor}:preview:${index}`);
    }
    return [preview];
  });
}

/**
 * A `Poll` with its votes. The archive lists each option's voters; a voter's
 * answer is every option they appear under, and `voteCount` (the same on all
 * of their entries) orders it against votes that arrive live afterwards.
 */
function backupPoll(poll: BackupRecord, directory: BackupDirectory): PollContent {
  const options = records(poll.options);
  const byVoter = new Map<string, PollVote>();
  options.forEach((option, index) => {
    for (const vote of records(option.votes)) {
      const voterId = directory.author(decimal(vote.voterId));
      if (!voterId) continue;
      const entry = byVoter.get(voterId) ?? { voterId, optionIndexes: [], voteCount: 0, at: 0 };
      entry.optionIndexes.push(index);
      entry.voteCount = Math.max(entry.voteCount, uint32(vote.voteCount, 0) ?? 0);
      byVoter.set(voterId, entry);
    }
  });
  return {
    question: clean(poll.question),
    options: options.map((option) => clean(option.option)),
    allowMultiple: poll.allowMultiple === true,
    ...(poll.hasEnded === true ? { ended: true } : {}),
    // A single-choice poll with several entries for one voter is not a vote Signal would accept.
    votes: [...byVoter.values()].filter(
      (v) => poll.allowMultiple === true || v.optionIndexes.length <= 1,
    ),
  };
}

function status(item: BackupRecord): MessageStatus {
  if (!isRecord(item.outgoing)) return 'read';
  const statuses = records(item.outgoing.sendStatus);
  if (statuses.some((entry) => isRecord(entry.read) || isRecord(entry.viewed))) return 'read';
  if (statuses.some((entry) => isRecord(entry.delivered))) return 'delivered';
  if (statuses.some((entry) => isRecord(entry.sent))) return 'sent';
  if (statuses.some((entry) => isRecord(entry.failed))) return 'failed';
  return 'pending'; // This is display state only; imported messages never enter the outbox.
}

export interface BackupMessageInput {
  archiveId: string;
  cursor: string;
  item: BackupRecord;
  directory: BackupDirectory;
  now: number;
}

/** Convert a current ChatItem; revisions supply identity, never resurrected content. */
export function backupMessage({
  archiveId,
  cursor,
  item,
  directory,
  now,
}: BackupMessageInput): Message | null {
  if (!isRecord(item.incoming) && !isRecord(item.outgoing) && !isRecord(item.directionless))
    return null;
  const conversation = directory.conversation(decimal(item.chatId));
  const authorId = directory.author(decimal(item.authorId));
  if (!conversation || !authorId) return null;
  const revisions = records(item.revisions);
  const original = revisions[0] ?? item;
  const sentAt = timestamp(original.dateSent);
  const receivedAt =
    timestamp(record(original.incoming ?? original.outgoing).dateReceived) || sentAt;
  const duration = timestamp(item.expiresInMs);
  const start = timestamp(item.expireStartDate);
  const expiresAt = duration && start ? start + duration : undefined;
  if (expiresAt !== undefined && (!Number.isSafeInteger(expiresAt) || expiresAt <= now))
    return null;
  const message: Message = {
    id: messageId(authorId, sentAt),
    conversationId: conversation.id,
    authorId,
    sentAt,
    receivedAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: status(item),
    kind: 'normal',
    historyCursor: `${archiveId}:${cursor}`,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(duration && !start ? { expiresAfterReadMs: duration } : {}),
  };
  if (isRecord(item.remoteDeletedMessage) || isRecord(item.adminDeletedMessage)) {
    message.deleted = true;
    const deletedBy = directory.author(decimal(record(item.adminDeletedMessage).adminId));
    if (deletedBy) message.deletedBy = deletedBy;
    return message;
  }
  if (isRecord(item.viewOnceMessage)) {
    message.body = 'View-once media — open it on your phone.';
    message.reactions = reactions(item.viewOnceMessage.reactions, directory);
    return message;
  }
  if (!isRecord(item.standardMessage)) {
    const content = additionalContent(item);
    if (!content) return null;
    message.body = content.body;
    message.reactions = reactions(content.reactions, directory);
    if (content.formattedText) message.ranges = bodyRanges(content.formattedText);
    if (content.sticker) {
      message.sticker = {
        packId: content.sticker.packId,
        stickerId: content.sticker.stickerId,
        ...(content.sticker.emoji ? { emoji: content.sticker.emoji } : {}),
        ...(content.sticker.data
          ? {
              backupAttachment: attachment(
                content.sticker.data,
                `history:${archiveId}:${cursor}:sticker:0`,
              ),
            }
          : {}),
      };
    }
    if (content.poll) message.poll = backupPoll(content.poll, directory);
    if (content.longText)
      message.attachments.push(
        attachment(
          { ...content.longText, fileName: text(content.longText.fileName) || 'message.txt' },
          `history:${archiveId}:${cursor}:longText:0`,
        ),
      );
    if (content.system) {
      message.kind = 'system';
      message.systemText = content.body;
      message.id = systemMessageId(authorId, sentAt, 'history-update');
    }
    return message;
  }
  const standard = item.standardMessage;
  const body = record(standard.text);
  message.body = text(body.body);
  message.ranges = bodyRanges(body);
  const quoted = quote(standard.quote, directory);
  if (quoted) message.quote = quoted;
  message.attachments = records(standard.attachments).flatMap((entry, index) =>
    isRecord(entry.pointer)
      ? [attachment(entry.pointer, `history:${archiveId}:${cursor}:attachment:${index}`)]
      : [],
  );
  message.reactions = reactions(standard.reactions, directory);
  const previews = linkPreviews(standard.linkPreview, archiveId, cursor);
  if (previews.length > 0) message.previews = previews;
  if (isRecord(standard.longText))
    message.attachments.push(
      attachment(
        { ...standard.longText, fileName: text(standard.longText.fileName) || 'message.txt' },
        `history:${archiveId}:${cursor}:longText:0`,
      ),
    );
  if (revisions.length) {
    message.edits = revisions.length;
    message.editedAt = timestamp(item.dateSent);
  }
  return message;
}
