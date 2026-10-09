import { stripBidiControls } from '@/core/lib';
import { timerSentence } from '../normalise/directory';
import { isRecord } from '../validate';
import { record, records, text, timestamp, type BackupRecord } from './wire';

interface Content {
  body: string;
  reactions?: unknown;
  system?: boolean;
  formattedText?: BackupRecord;
  sticker?: BackupRecord;
  longText?: BackupRecord;
}
const clean = (value: unknown): string => stripBidiControls(text(value));

/** Known non-text kinds remain visible even when their phone-only actions are unavailable. */
export function additionalContent(item: BackupRecord): Content | null {
  if (isRecord(item.contactMessage)) {
    const contact = record(item.contactMessage.contact);
    const name = record(contact.name);
    const display =
      clean(name.nickname) ||
      [name.prefix, name.givenName, name.middleName, name.familyName, name.suffix]
        .map(clean)
        .filter(Boolean)
        .join(' ');
    const details = [
      clean(contact.organization),
      ...records(contact.number).map((number) => clean(number.value)),
      ...records(contact.email).map((email) => clean(email.value)),
      ...records(contact.address).map((address) =>
        [
          address.street,
          address.pobox,
          address.neighborhood,
          address.city,
          address.region,
          address.postcode,
          address.country,
        ]
          .map(clean)
          .filter(Boolean)
          .join(', '),
      ),
    ].filter(Boolean);
    return {
      body: [display ? `Shared a contact: ${display}` : 'Shared a contact.', ...details].join('\n'),
      reactions: item.contactMessage.reactions,
    };
  }
  if (isRecord(item.stickerMessage)) {
    const sticker = record(item.stickerMessage.sticker);
    return {
      body: clean(sticker.emoji) || 'Sent a sticker.',
      reactions: item.stickerMessage.reactions,
      ...(isRecord(sticker.data) ? { sticker: sticker.data } : {}),
    };
  }
  if (isRecord(item.poll)) {
    const poll = item.poll;
    return {
      body: [
        `Poll: ${text(poll.question)}`,
        ...records(poll.options).map((option) => `• ${text(option.option)}`),
        poll.hasEnded === true ? 'Poll closed.' : 'Vote on your phone.',
      ].join('\n'),
      reactions: poll.reactions,
    };
  }
  if (isRecord(item.directStoryReplyMessage)) {
    const reply = item.directStoryReplyMessage;
    if (isRecord(reply.textReply)) {
      const formattedText = record(reply.textReply.text);
      return {
        body: text(formattedText.body),
        formattedText,
        reactions: reply.reactions,
        ...(isRecord(reply.textReply.longText) ? { longText: reply.textReply.longText } : {}),
      };
    }
    if (text(reply.emoji))
      return { body: `Story reaction: ${text(reply.emoji)}`, reactions: reply.reactions };
    return null;
  }
  if (isRecord(item.paymentNotification))
    return { body: 'Sent a payment — view it on your phone.' };
  if (isRecord(item.giftBadge)) return { body: 'Sent a gift badge — view it on your phone.' };
  if (isRecord(item.updateMessage)) {
    const body = describeUpdate(item.updateMessage);
    return body ? { body, system: true } : null;
  }
  return null;
}

const SIMPLE: Record<string, string> = {
  JOINED_SIGNAL: 'Joined Signal.',
  IDENTITY_UPDATE: 'Safety number changed.',
  IDENTITY_VERIFIED: 'Safety number marked verified.',
  IDENTITY_DEFAULT: 'Safety number marked unverified.',
  CHANGE_NUMBER: 'Phone number changed.',
  RELEASE_CHANNEL_DONATION_REQUEST: 'Signal donation request.',
  END_SESSION: 'Secure session reset.',
  CHAT_SESSION_REFRESH: 'Secure session refreshed.',
  BAD_DECRYPT: 'A message could not be decrypted.',
  PAYMENTS_ACTIVATED: 'Payments activated.',
  PAYMENT_ACTIVATION_REQUEST: 'Payments activation requested.',
  UNSUPPORTED_PROTOCOL_MESSAGE: 'Message requires a newer Signal version.',
  REPORTED_SPAM: 'Reported as spam.',
  BLOCKED: 'Contact blocked.',
  UNBLOCKED: 'Contact unblocked.',
  MESSAGE_REQUEST_ACCEPTED: 'Message request accepted.',
};
function describeUpdate(update: BackupRecord): string | null {
  if (isRecord(update.simpleUpdate)) return SIMPLE[text(update.simpleUpdate.type)] ?? null;
  if (isRecord(update.expirationTimerChange))
    return timerSentence(null, timestamp(update.expirationTimerChange.expiresInMs) / 1000);
  if (isRecord(update.profileChange)) {
    const previous = clean(update.profileChange.previousName);
    const next = clean(update.profileChange.newName);
    return previous && next
      ? `${previous} changed their profile name to ${next}.`
      : 'Profile name changed.';
  }
  if (isRecord(update.individualCall)) {
    const call = update.individualCall;
    const kind = call.type === 'VIDEO_CALL' ? 'video' : 'voice';
    const state = text(call.state);
    const prefix = state.startsWith('MISSED')
      ? 'Missed'
      : state === 'NOT_ACCEPTED'
        ? 'Unanswered'
        : call.direction === 'OUTGOING'
          ? 'Outgoing'
          : 'Incoming';
    return `${prefix} ${kind} call.`;
  }
  if (isRecord(update.groupCall))
    return text(update.groupCall.state).startsWith('MISSED') ? 'Missed group call.' : 'Group call.';
  if (isRecord(update.groupChange)) {
    return (
      records(update.groupChange.updates)
        .map((change) => {
          if (isRecord(change.groupNameUpdate)) {
            const name = clean(change.groupNameUpdate.newGroupName);
            return name ? `Group name changed to ${name}.` : 'Group name removed.';
          }
          if (isRecord(change.groupExpirationTimerUpdate))
            return timerSentence(
              null,
              timestamp(change.groupExpirationTimerUpdate.expiresInMs) / 1000,
            );
          if (isRecord(change.groupCreationUpdate)) return 'Group created.';
          if (isRecord(change.groupAvatarUpdate))
            return change.groupAvatarUpdate.wasRemoved === true
              ? 'Group photo removed.'
              : 'Group photo changed.';
          if (isRecord(change.groupDescriptionUpdate)) {
            const description = clean(change.groupDescriptionUpdate.newDescription);
            return description
              ? `Group description changed: ${description}`
              : 'Group description removed.';
          }
          return 'Group settings or membership changed.';
        })
        .join('\n') || 'Group updated.'
    );
  }
  if (isRecord(update.threadMerge))
    return 'Conversation history merged after a phone number change.';
  if (isRecord(update.sessionSwitchover)) return 'Secure conversation switched to a new session.';
  if (isRecord(update.learnedProfileChange)) return 'Profile information updated.';
  if (isRecord(update.pollTerminate)) return 'Poll closed.';
  if (isRecord(update.pinMessage)) return 'A message was pinned.';
  return null;
}
