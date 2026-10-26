/**
 * The plain-text system lines for a group change, shared by every adapter so
 * a change reads the same whoever's backend reports it.
 */
import { formatDuration, type Conversation, type GroupPermission } from '@/core/domain';
import { stripBidiControls } from '@/core/lib';

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

const permissionLabel = (p: GroupPermission): string =>
  p === 'only-admins' ? '"Only admins."' : '"All members."';

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Human-readable lines describing how a group changed. `actorName` null
 * phrases changes passively (several people changed things in one batch).
 * `mine` says the change is ours (`actorName` is "You"): we know what we did,
 * so it can say "added" and "removed" where, for someone else's change, the
 * protocol only lets us say that people joined or left.
 */
export function describeGroupChange(
  before: Conversation | undefined,
  after: Conversation,
  actorName: string | null,
  nameOf: (id: string) => string,
  mine = false,
): string[] {
  if (!before) return [actorName ? `${actorName} updated the group.` : 'The group was updated.'];
  const lines: string[] = [];
  const names = (ids: readonly string[]): string => ids.map(nameOf).join(', ');
  const did = (text: string, passive: string): void => {
    lines.push(actorName ? `${actorName} ${text}` : passive);
  };
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
  if ((before.avatarUrl ?? '') !== (after.avatarUrl ?? '')) {
    did(
      `${after.avatarUrl ? 'changed' : 'removed'} the group avatar.`,
      `The group avatar was ${after.avatarUrl ? 'changed' : 'removed'}.`,
    );
  }
  if (before.expireTimerSec !== after.expireTimerSec) {
    lines.push(timerSentence(actorName, after.expireTimerSec));
  }
  const was = new Set(before.memberIds);
  const is = new Set(after.memberIds);
  const asked = new Set(before.requestingMemberIds ?? []);
  const approved = after.memberIds.filter((id) => asked.has(id) && !was.has(id));
  const approvedSet = new Set(approved);
  const joined = after.memberIds.filter((id) => !was.has(id) && !approvedSet.has(id));
  const left = before.memberIds.filter((id) => !is.has(id));
  if (approved.length > 0) {
    if (mine) lines.push(`You approved a request to join the group from ${names(approved)}.`);
    else if (actorName)
      lines.push(`${actorName} approved a request to join the group from ${names(approved)}.`);
    else lines.push(`A request to join the group from ${names(approved)} has been approved.`);
  }
  // Otherwise the protocol doesn't tell us whether someone joined or was added
  // (or left vs. was removed), so the wording stays neutral.
  if (joined.length > 0)
    lines.push(mine ? `You added ${names(joined)}.` : `${names(joined)} joined the group.`);
  if (left.length > 0)
    lines.push(mine ? `You removed ${names(left)}.` : `${names(left)} left the group.`);
  if (before.pendingMemberIds && after.pendingMemberIds) {
    const invitedBefore = new Set(before.pendingMemberIds);
    const invitedNow = new Set(after.pendingMemberIds);
    const invited = after.pendingMemberIds.filter((id) => !invitedBefore.has(id));
    // An invite that vanished because the person joined is not a withdrawal.
    const withdrawn = before.pendingMemberIds.filter((id) => !invitedNow.has(id) && !is.has(id));
    if (invited.length > 0) {
      if (mine) lines.push(`You invited ${names(invited)} to the group.`);
      else if (actorName)
        lines.push(
          `${actorName} invited ${invited.length} ${plural(invited.length, 'person', 'people')} to the group.`,
        );
      else
        lines.push(
          `${invited.length} ${plural(invited.length, 'person was', 'people were')} invited to the group.`,
        );
    }
    if (withdrawn.length > 0) {
      if (mine) lines.push(`You revoked an invitation to the group for ${names(withdrawn)}.`);
      else
        lines.push(
          `${plural(withdrawn.length, 'An invitation', `${withdrawn.length} invitations`)} to the group ${plural(withdrawn.length, 'was', 'were')} withdrawn.`,
        );
    }
  }
  if (before.requestingMemberIds && after.requestingMemberIds) {
    const askedNow = new Set(after.requestingMemberIds);
    const newlyAsked = after.requestingMemberIds.filter((id) => !asked.has(id));
    const turnedAway = before.requestingMemberIds.filter((id) => !askedNow.has(id) && !is.has(id));
    if (newlyAsked.length > 0)
      lines.push(`${names(newlyAsked)} requested to join via the group link.`);
    if (turnedAway.length > 0) {
      lines.push(
        mine
          ? `You denied a request to join the group from ${names(turnedAway)}.`
          : `A request to join the group from ${names(turnedAway)} is no longer pending.`,
      );
    }
  }
  const wasAdmin = new Set(before.adminIds);
  const isAdmin = new Set(after.adminIds);
  const promoted = after.adminIds.filter((id) => !wasAdmin.has(id) && was.has(id));
  if (promoted.length > 0) {
    lines.push(
      mine
        ? `You made ${names(promoted)} an admin.`
        : `${names(promoted)} ${promoted.length === 1 ? 'is' : 'are'} now an admin.`,
    );
  }
  const demoted = before.adminIds.filter((id) => !isAdmin.has(id) && is.has(id));
  if (demoted.length > 0) {
    lines.push(
      mine
        ? `You removed ${names(demoted)} as an admin.`
        : `${names(demoted)} ${demoted.length === 1 ? 'is' : 'are'} no longer an admin.`,
    );
  }
  const oldRules = before.permissions;
  const newRules = after.permissions;
  if (oldRules && newRules) {
    const by = actorName ?? 'An admin';
    if (oldRules.editDetails !== newRules.editDetails)
      lines.push(
        `${by} changed who can edit group info to ${permissionLabel(newRules.editDetails)}`,
      );
    if (oldRules.addMember !== newRules.addMember)
      lines.push(
        `${by} changed who can edit group membership to ${permissionLabel(newRules.addMember)}`,
      );
    if (oldRules.sendMessages !== newRules.sendMessages) {
      const only = newRules.sendMessages === 'only-admins';
      const rule = only ? 'only allow admins' : 'allow all members';
      lines.push(
        actorName
          ? `${actorName} changed the group settings to ${rule} to send messages.`
          : `The group was changed to ${rule} to send messages.`,
      );
    }
  }
  if (before.inviteLink !== after.inviteLink) {
    if (!before.inviteLink) did('turned on the group link.', 'The group link has been turned on.');
    else if (!after.inviteLink)
      did('turned off the group link.', 'The group link has been turned off.');
    else did('reset the group link.', 'The group link has been reset.');
  }
  return lines;
}
