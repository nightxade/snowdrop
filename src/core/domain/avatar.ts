/**
 * Which picture a backend is asked for: a person's (a contact, or the user)
 * or a group's. Avatars are fetched lazily by reference, never carried inside
 * `Contact` / `Conversation`, so a list of hundreds costs nothing until a row
 * is actually on screen.
 */
import type { ConversationId } from './ids';

export type AvatarRef = { kind: 'contact'; id: string } | { kind: 'group'; id: ConversationId };

/** A stable cache key for a reference. */
export function avatarKey(ref: AvatarRef): string {
  return `${ref.kind}:${ref.id}`;
}
