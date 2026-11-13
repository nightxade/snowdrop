/**
 * The wording of the status lines Signal Desktop shows in a chat for changes
 * that are not messages (a pin, a profile name change, a request answer).
 * `actor` strings are display names; callers strip bidi controls from them
 * first, since the result is plain text.
 */

/** "You pinned a message" / "Mira pinned a message". */
export function pinnedText(actor: string): string {
  return `${actor} pinned a message`;
}

/**
 * Desktop words a profile name change differently when the person has a saved
 * (contact or nickname) name: then the line names them by it.
 */
export function profileChangeText(
  change: { oldName: string; newName: string },
  savedName: string | undefined,
): string {
  return savedName
    ? `${savedName} changed their profile name from ${change.oldName} to ${change.newName}.`
    : `${change.oldName} changed their profile name to ${change.newName}.`;
}

export const SESSION_RESET_TEXT = 'Secure session reset';

export type RequestAnswer = 'accepted' | 'blocked' | 'unblocked' | 'reported';

/** Desktop's `MessageRequestResponseNotification` lines for the user's own answers. */
export function requestAnswerText(
  answer: RequestAnswer,
  isGroup: boolean,
  personName?: string,
): string {
  switch (answer) {
    case 'accepted':
      return isGroup || !personName
        ? 'You accepted the message request'
        : `You accepted ${personName}'s message request`;
    case 'blocked':
      return isGroup ? 'You blocked the group' : 'You blocked this person';
    case 'unblocked':
      return isGroup ? 'You unblocked the group' : 'You unblocked this person';
    case 'reported':
      return 'Reported as spam';
  }
}
