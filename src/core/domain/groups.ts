/**
 * Who may do what in a group, and the limits on a group's details, as Signal
 * Desktop applies them. Pure functions of a `Conversation` and our own id, so
 * the UI hides (and the service refuses) exactly what our role can't do.
 */
import type { Conversation, GroupPermission } from './types';

/** Longest group name and description, in characters (Desktop's limits). */
export const GROUP_LIMITS = { title: 32, description: 480 } as const;

type GroupRole = Pick<Conversation, 'kind' | 'adminIds' | 'memberIds'> &
  Partial<Pick<Conversation, 'permissions' | 'left'>>;

const isGroup = (c: GroupRole | undefined): c is GroupRole => c?.kind === 'group';

export function isGroupMember(c: GroupRole | undefined, selfId: string | null): boolean {
  return isGroup(c) && !c.left && selfId !== null && c.memberIds.includes(selfId);
}

export function isGroupAdmin(c: GroupRole | undefined, selfId: string | null): boolean {
  return isGroup(c) && !c.left && selfId !== null && c.adminIds.includes(selfId);
}

/**
 * A rule open to every member, or to admins only. When the group's rules
 * aren't known, only admins are assumed to pass: a button that wrongly
 * shows costs a failed request, one that wrongly hides is never missed.
 */
function allowed(
  c: GroupRole | undefined,
  selfId: string | null,
  rule: GroupPermission | undefined,
): boolean {
  if (!isGroupMember(c, selfId)) return false;
  return isGroupAdmin(c, selfId) || rule === 'every-member';
}

/** Name, photo and description (Desktop's `canEditGroupInfo`). */
export function canEditGroupInfo(c: GroupRole | undefined, selfId: string | null): boolean {
  return allowed(c, selfId, c?.permissions?.editDetails);
}

/** Desktop's `canAddNewMembers`. */
export function canAddMembers(c: GroupRole | undefined, selfId: string | null): boolean {
  return allowed(c, selfId, c?.permissions?.addMember);
}

/** Removing people, making admins, answering requests and the link are admin-only. */
export function canManageGroup(c: GroupRole | undefined, selfId: string | null): boolean {
  return isGroupAdmin(c, selfId);
}

/** False in an announcement group (only admins send) for anyone who isn't an admin. */
export function canSendToGroup(c: GroupRole | undefined, selfId: string | null): boolean {
  if (!isGroup(c)) return true;
  // A group we left is read-only.
  if (c.left) return false;
  if (c.permissions?.sendMessages !== 'only-admins') return true;
  return isGroupAdmin(c, selfId);
}

/**
 * Whether leaving needs a new admin first: we are the only admin and someone
 * else is in the group (Desktop's `getCannotLeaveBecauseYouAreLastAdmin`).
 */
export function mustChooseNewAdmin(c: GroupRole | undefined, selfId: string | null): boolean {
  if (!isGroup(c) || selfId === null || !isGroupAdmin(c, selfId)) return false;
  const others = c.memberIds.filter((id) => id !== selfId);
  return others.length > 0 && !c.adminIds.some((id) => id !== selfId);
}

/** Group text as saved: line breaks in a name become spaces; both are trimmed. */
export function normalizeGroupTitle(text: string): string {
  return text.replace(/[\r\n]+/gu, ' ').trim();
}

export function normalizeGroupDescription(text: string): string {
  return text.trim();
}
