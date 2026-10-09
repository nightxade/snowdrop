import {
  colorForId,
  directConversationId,
  groupConversationId,
  type Contact,
  type Conversation,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
import { isRecord } from '../validate';
import { decimal, record, records, text, timestamp, type BackupRecord } from './wire';

/** Backup ACI bytes, unlike archive-local recipient IDs, are actual Signal identities. */
export function backupUuid(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    let bytes = atob(value);
    if (bytes.length === 17 && bytes.charCodeAt(0) === 0) bytes = bytes.slice(1);
    if (bytes.length !== 16) return undefined;
    const hex = Array.from(bytes, (byte) => byte.charCodeAt(0).toString(16).padStart(2, '0')).join(
      '',
    );
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return undefined;
  }
}
const name = (...parts: unknown[]): string =>
  stripBidiControls(parts.map(text).filter(Boolean).join(' ').trim());

interface Destination {
  id: string;
  contact?: Contact;
  group?: Conversation;
}

/** Small archive directory retained while individual chats are paged on demand. */
export class BackupDirectory {
  private readonly recipients = new Map<string, Destination>();
  private readonly chats = new Map<string, BackupRecord>();

  constructor(
    readonly selfId: string,
    private readonly resolve: (id: string) => string = (id) => id,
  ) {}

  add(frame: BackupRecord): void {
    if (isRecord(frame.recipient)) {
      const recipient = frame.recipient;
      const id = decimal(recipient.id);
      if (isRecord(recipient.self)) {
        this.recipients.set(id, { id: this.selfId });
      } else if (isRecord(recipient.contact)) {
        const value = recipient.contact;
        const aci = backupUuid(value.aci);
        const number =
          value.e164 === undefined || value.e164 === '0' ? undefined : `+${decimal(value.e164)}`;
        const pni = backupUuid(value.pni);
        const address = aci ?? number ?? (pni ? `PNI:${pni}` : undefined);
        if (!address) return;
        const canonical = this.resolve(address);
        const nickname = record(value.nickname);
        const profileName = name(value.profileGivenName, value.profileFamilyName);
        const contact: Contact = {
          id: canonical,
          color: colorForId(canonical),
          name:
            name(nickname.given, nickname.family) ||
            name(value.systemNickname) ||
            name(value.systemGivenName, value.systemFamilyName) ||
            profileName ||
            number ||
            text(value.username) ||
            'Unknown',
          ...(number ? { number } : {}),
          ...(profileName ? { profileName } : {}),
          blocked: value.blocked === true,
          hidden: ['HIDDEN', 'HIDDEN_MESSAGE_REQUEST'].includes(text(value.visibility)),
          unregistered: isRecord(value.notRegistered),
          profileSharing: value.profileSharing === true,
        };
        this.recipients.set(id, { id: canonical, contact });
      } else if (isRecord(recipient.group)) {
        const groupId = text(frame.signalGroupId);
        if (!groupId) throw new Error('History directory is missing a derived Signal group id');
        const snapshot = record(recipient.group.snapshot);
        const members = records(snapshot.members).flatMap((member) => {
          const aci = backupUuid(member.userId);
          return aci ? [{ id: this.resolve(aci), admin: member.role === 'ADMINISTRATOR' }] : [];
        });
        const description = text(record(snapshot.description).descriptionText);
        const group: Conversation = {
          id: groupConversationId(groupId),
          kind: 'group',
          title: name(record(snapshot.title).title) || 'Unnamed group',
          ...(description ? { description } : {}),
          memberIds: members.map((member) => member.id),
          adminIds: members.filter((member) => member.admin).map((member) => member.id),
          expireTimerSec: 0,
          lastActivityAt: 0,
        };
        this.recipients.set(id, { id: group.id, group });
      }
    }
    if (isRecord(frame.chat)) this.chats.set(decimal(frame.chat.id), frame.chat);
  }

  author(recipientId: string): string | undefined {
    const recipient = this.recipients.get(recipientId);
    return recipient?.group ? undefined : recipient?.id;
  }

  contacts(): Contact[] {
    return [
      ...new Map(
        [...this.recipients.values()].flatMap((recipient) =>
          recipient.contact ? [[recipient.contact.id, recipient.contact] as const] : [],
        ),
      ).values(),
    ];
  }

  conversation(chatId: string): Conversation | undefined {
    const chat = this.chats.get(chatId);
    if (!chat) return undefined;
    const destination = this.recipients.get(decimal(chat.recipientId));
    if (!destination) return undefined;
    const expireTimerSec = Math.floor(timestamp(chat.expirationTimerMs) / 1000);
    if (destination.group) return { ...destination.group, expireTimerSec };
    return {
      id: directConversationId(destination.id),
      kind: 'direct',
      title:
        destination.id === this.selfId ? 'Note to self' : (destination.contact?.name ?? 'Unknown'),
      memberIds: [...new Set([this.selfId, destination.id])],
      adminIds: [],
      expireTimerSec,
      lastActivityAt: 0,
    };
  }

  conversations(): Conversation[] {
    return [...this.chats.keys()].flatMap((id) => {
      const conversation = this.conversation(id);
      return conversation ? [conversation] : [];
    });
  }

  chatId(conversationId: string): string | undefined {
    return [...this.chats.keys()].find((id) => this.conversation(id)?.id === conversationId);
  }
}
