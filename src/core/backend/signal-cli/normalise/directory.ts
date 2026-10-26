/**
 * listContacts / listGroups results → domain contacts and conversations, and
 * the diff that turns a group update into a readable system line.
 *
 * Group-update envelopes don't say *what* changed (signal-cli only reports
 * `groupInfo.type = "UPDATE"`), so we re-list the group and compare with what
 * we knew before.
 */
import {
  colorForId,
  directConversationId,
  groupConversationId,
  type Contact,
  type Conversation,
  type GroupMemberLabel,
  type GroupPermission,
} from '@/core/domain';
import { addressId, type WireContact, type WireGroup } from '../wire';

const joinName = (...parts: (string | undefined)[]): string =>
  parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ')
    .trim();

/** Signal's display-name precedence: nickname → contact name → profile name → number. */
export function toContact(c: WireContact, selfId: string): Contact | null {
  const id = addressId(c.uuid, c.number);
  if (!id) return null;
  const nickname = c.nickName ?? joinName(c.nickGivenName, c.nickFamilyName);
  const contactName = c.name ?? joinName(c.givenName, c.familyName);
  const profileName = joinName(c.profile?.givenName, c.profile?.familyName);
  const name = nickname || contactName || profileName || c.number || c.username || 'Unknown';
  const contact: Contact = { id, name, color: colorForId(id) };
  if (c.number) contact.number = c.number;
  if (profileName) contact.profileName = profileName;
  if (c.profile?.givenName) contact.profileGivenName = c.profile.givenName;
  if (c.profile?.familyName) contact.profileFamilyName = c.profile.familyName;
  if (c.profile?.about) contact.about = c.profile.about;
  if (c.profile?.aboutEmoji) contact.aboutEmoji = c.profile.aboutEmoji;
  if (c.profile?.hasAvatar === true) {
    contact.hasAvatar = true;
    if (c.profile.lastUpdateTimestamp) contact.avatarVersion = c.profile.lastUpdateTimestamp;
  }
  if (c.isBlocked) contact.blocked = true;
  if (c.isHidden) contact.hidden = true;
  if (c.unregistered) contact.unregistered = true;
  if (c.profileSharing) contact.profileSharing = true;
  // A name from the contact sync is one the user (or their address book) gave
  // the person; the profile name is the one the person chose for themselves.
  if (nickname || contactName) contact.inContacts = true;
  if (id === selfId) contact.isSelf = true;
  return contact;
}

const permissionOf = (name: string | undefined): GroupPermission =>
  name === 'ONLY_ADMINS' ? 'only-admins' : 'every-member';

/** Sorted and de-duplicated: signal-cli lists these from a set, in no stable order. */
function addressIds(
  addresses: readonly { uuid?: string | undefined; number?: string | undefined }[],
  resolve: (id: string) => string,
): string[] {
  const ids = addresses.flatMap((a) => {
    const id = addressId(a.uuid, a.number);
    return id ? [resolve(id)] : [];
  });
  return [...new Set(ids)].sort();
}

export function toGroupConversation(
  g: WireGroup,
  resolve: (id: string) => string,
  lastActivityAt: number,
): Conversation {
  const members = g.members.flatMap((m) => {
    const id = addressId(m.uuid, m.number);
    return id ? [{ id: resolve(id), isAdmin: m.isAdmin === true }] : [];
  });
  let adminIds = members.filter((m) => m.isAdmin).map((m) => m.id);
  if (adminIds.length === 0) {
    adminIds = g.admins.flatMap((a) => {
      const id = addressId(a.uuid, a.number);
      return id ? [resolve(id)] : [];
    });
  }
  const conv: Conversation = {
    id: groupConversationId(g.id),
    kind: 'group',
    title: g.name?.trim() || 'Unnamed group',
    memberIds: members.map((m) => m.id),
    adminIds,
    expireTimerSec: g.messageExpirationTime,
    lastActivityAt,
  };
  if (g.description) conv.description = g.description;
  if (g.isBlocked) conv.blocked = true;
  // Each of these is only set when the daemon reported it, so an older
  // signal-cli reads as "unknown" rather than as "no pending invites".
  if (g.pendingMembers) conv.pendingMemberIds = addressIds(g.pendingMembers, resolve);
  if (g.requestingMembers) conv.requestingMemberIds = addressIds(g.requestingMembers, resolve);
  if (g.banned) conv.bannedIds = addressIds(g.banned, resolve);
  if (g.permissionAddMember || g.permissionEditDetails || g.permissionSendMessage) {
    conv.permissions = {
      addMember: permissionOf(g.permissionAddMember),
      editDetails: permissionOf(g.permissionEditDetails),
      sendMessages: permissionOf(g.permissionSendMessage),
    };
  }
  if (g.groupInviteLink) conv.inviteLink = g.groupInviteLink;
  const labels: Record<string, GroupMemberLabel> = {};
  for (const m of g.members) {
    const id = addressId(m.uuid, m.number);
    if (!id || (!m.label && !m.labelEmoji)) continue;
    labels[resolve(id)] = {
      ...(m.labelEmoji ? { emoji: m.labelEmoji } : {}),
      ...(m.label ? { label: m.label } : {}),
    };
  }
  if (Object.keys(labels).length > 0) conv.memberLabels = labels;
  return conv;
}

export function toDirectConversation(
  peerId: string,
  selfId: string,
  contact: Contact | undefined,
  expireTimerSec: number,
  lastActivityAt: number,
): Conversation {
  return {
    id: directConversationId(peerId),
    kind: 'direct',
    title: peerId === selfId ? 'Note to Self' : (contact?.name ?? peerId),
    memberIds: peerId === selfId ? [selfId] : [selfId, peerId],
    adminIds: [],
    expireTimerSec,
    lastActivityAt,
  };
}

export { describeGroupChange, timerSentence } from '../../groupLines';
