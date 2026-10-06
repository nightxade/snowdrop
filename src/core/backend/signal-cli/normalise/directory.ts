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
  formatDuration,
  groupConversationId,
  type Contact,
  type Conversation,
} from '@/core/domain';
import { stripBidiControls } from '@/core/lib';
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
  if (c.profile?.about) contact.about = c.profile.about;
  if (c.profile?.aboutEmoji) contact.aboutEmoji = c.profile.aboutEmoji;
  if (c.isBlocked) contact.blocked = true;
  if (c.isHidden) contact.hidden = true;
  if (c.unregistered) contact.unregistered = true;
  if (c.profileSharing) contact.profileSharing = true;
  if (id === selfId) contact.isSelf = true;
  return contact;
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

/** "Disappearing messages" sentence for a timer value, with or without an actor. */
export function timerSentence(actorName: string | null, seconds: number): string {
  if (actorName === null) {
    return seconds > 0
      ? `Disappearing messages were set to ${formatDuration(seconds)}.`
      : 'Disappearing messages were turned off.';
  }
  return seconds > 0
    ? `${actorName} set disappearing messages to ${formatDuration(seconds)}.`
    : `${actorName} turned off disappearing messages.`;
}

/**
 * Human-readable lines describing how a group changed. `actorName` null
 * phrases changes passively (several people changed things in one batch).
 */
export function describeGroupChange(
  before: Conversation | undefined,
  after: Conversation,
  actorName: string | null,
  nameOf: (id: string) => string,
): string[] {
  if (!before) return [actorName ? `${actorName} updated the group.` : 'The group was updated.'];
  const lines: string[] = [];
  if (before.title !== after.title) {
    const title = stripBidiControls(after.title);
    lines.push(
      actorName
        ? `${actorName} changed the group name to "${title}".`
        : `The group name was changed to "${title}".`,
    );
  }
  if ((before.description ?? '') !== (after.description ?? '')) {
    const verb = after.description ? 'changed' : 'removed';
    lines.push(
      actorName
        ? `${actorName} ${verb} the group description.`
        : `The group description was ${verb}.`,
    );
  }
  if (before.expireTimerSec !== after.expireTimerSec) {
    lines.push(timerSentence(actorName, after.expireTimerSec));
  }
  const was = new Set(before.memberIds);
  const is = new Set(after.memberIds);
  const joined = after.memberIds.filter((id) => !was.has(id));
  const left = before.memberIds.filter((id) => !is.has(id));
  const names = (ids: string[]): string => ids.map(nameOf).join(', ');
  // The protocol doesn't tell us whether someone joined or was added (or left
  // vs. was removed), so the wording stays neutral.
  if (joined.length > 0) lines.push(`${names(joined)} joined the group.`);
  if (left.length > 0) lines.push(`${names(left)} left the group.`);
  const wasAdmin = new Set(before.adminIds);
  const promoted = after.adminIds.filter((id) => !wasAdmin.has(id) && was.has(id));
  if (promoted.length > 0) {
    lines.push(`${names(promoted)} ${promoted.length === 1 ? 'is' : 'are'} now an admin.`);
  }
  return lines;
}
