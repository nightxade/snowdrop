import { useStore } from 'zustand';
import type { ConversationId } from '@/core/domain';
import { useAvatarSrc, useStores } from '@/ui/hooks';
import { Avatar, type AvatarProps } from '@/ui/primitives';
import { usePersonAvatarHold } from './avatarHold';

export type PersonAvatarProps = Omit<AvatarProps, 'src' | 'ref' | 'veil'> & {
  /** Whose picture; without one (an unknown author) only the fallback shows. */
  contactId: string | undefined;
  /**
   * The conversation this avatar sits in. A stranger's picture stays hidden
   * until the user accepts it: here, or by choosing to view it.
   */
  conversationId?: ConversationId | undefined;
  /** Offer "View photo" in place of a hidden picture (large avatars only). */
  revealable?: boolean;
};

/**
 * A person's avatar: their real picture when there is one and it may be
 * shown, otherwise the initials on their colour, in the same box either way
 * (nothing shifts when the picture arrives).
 */
export function PersonAvatar({
  contactId,
  conversationId,
  revealable = false,
  ...avatar
}: PersonAvatarProps) {
  const { contacts } = useStores();
  const contact = useStore(contacts, (s) => (contactId ? s.byId[contactId] : undefined));
  const { held, reveal } = usePersonAvatarHold(contactId, conversationId);
  const [ref, src] = useAvatarSrc('contact', contactId, {
    version: contact?.avatarVersion,
    known: contact?.avatarUrl,
    held,
  });
  const veil =
    held && revealable && contact?.hasAvatar === true
      ? { label: 'View photo', onReveal: reveal }
      : undefined;
  return <Avatar {...avatar} ref={ref} src={src} veil={veil} />;
}
