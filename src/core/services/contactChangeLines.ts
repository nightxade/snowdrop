/**
 * The status line for a contact whose profile name changed (Signal Desktop's
 * "X changed their profile name…"). Only a change from a name we already held
 * to a different one counts: learning a name for the first time (after
 * linking, a contact refresh, a history import) says nothing happened.
 */
import {
  directConversationId,
  profileChangeText,
  systemMessageId,
  type Contact,
  type Conversation,
  type ConversationId,
  type Message,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';

/** The chats such a line goes in: the direct chat and every group they share with the user. */
function chatsWith(
  contactId: string,
  conversations: Readonly<Record<string, Conversation>>,
): ConversationId[] {
  const direct = directConversationId(contactId);
  const ids: ConversationId[] = conversations[direct] ? [direct] : [];
  for (const conv of Object.values(conversations))
    if (conv.kind === 'group' && !conv.left && conv.memberIds.includes(contactId))
      ids.push(conv.id);
  return ids;
}

/** A short stable digest, so ids never carry the names themselves. */
function digest(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16);
}

/** Names compared as people see them: composed, trimmed, inner whitespace collapsed. */
function normaliseName(name: string): string {
  return name.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

function line(
  contactId: string,
  conversationId: ConversationId,
  idAt: number,
  sentAt: number,
  text: string,
  tag: string,
): Message {
  return {
    id: systemMessageId(contactId, idAt, `${tag}:${conversationId}`),
    conversationId,
    authorId: contactId,
    sentAt,
    receivedAt: sentAt,
    body: '',
    ranges: [],
    attachments: [],
    reactions: [],
    status: 'sent',
    kind: 'system',
    systemText: text,
    previewless: true,
  };
}

export function contactChangeLines(
  previous: Contact | undefined,
  next: Contact,
  conversations: Readonly<Record<string, Conversation>>,
  selfId: string | undefined,
  now: number,
): Message[] {
  if (!previous || next.isSelf === true || next.id === selfId) return [];
  const lines: Message[] = [];

  const before = previous.profileName ? normaliseName(previous.profileName) : '';
  const after = next.profileName ? normaliseName(next.profileName) : '';
  // A listing older than the one we hold (a stale cache answering late) is not a change.
  const stale =
    next.avatarVersion !== undefined &&
    previous.avatarVersion !== undefined &&
    next.avatarVersion < previous.avatarVersion;
  if (before && after && before !== after && !stale) {
    const saved =
      next.name !== next.profileName && next.name !== next.number
        ? stripBidiControls(next.name)
        : undefined;
    const text = profileChangeText(
      { oldName: stripBidiControls(before), newName: stripBidiControls(after) },
      saved,
    );
    // The id depends on the chat, the two names and the profile's own update time
    // only, never on when we noticed: the same change seen again is the same line.
    const tag = `profile-name:${digest(`${before}\u0000${after}`)}`;
    const idAt = next.avatarVersion ?? 0;
    for (const id of chatsWith(next.id, conversations))
      lines.push(line(next.id, id, idAt, now, text, tag));
  }
  return lines;
}
