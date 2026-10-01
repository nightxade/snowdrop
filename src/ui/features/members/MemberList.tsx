import { useMemo } from 'react';
import { useStore } from 'zustand';
import type { Contact, ConversationId } from '@/core/domain';
import { useRovingFocus, useStores } from '@/ui/hooks';
import { Scroller } from '@/ui/primitives';
import { MemberRow } from './MemberRow';
import styles from './MemberList.module.css';

export interface MemberSection {
  title: string;
  members: Contact[];
}

/** Admins first, then members; each alphabetical, you included (PLAN §4.7). */
export function buildMemberSections(
  conversation: { memberIds: readonly string[]; adminIds: readonly string[] },
  contacts: Readonly<Record<string, Contact>>,
): MemberSection[] {
  const byName = (a: Contact, b: Contact) => a.name.localeCompare(b.name);
  const admins = new Set(conversation.adminIds);
  const all = conversation.memberIds.flatMap((id) => {
    const c = contacts[id];
    return c ? [c] : [];
  });
  const sections: MemberSection[] = [
    { title: 'Admins', members: all.filter((c) => admins.has(c.id)).sort(byName) },
    { title: 'Members', members: all.filter((c) => !admins.has(c.id)).sort(byName) },
  ];
  return sections.filter((s) => s.members.length > 0);
}

const NONE: readonly string[] = [];

export function MemberList({ conversationId }: { conversationId: ConversationId }) {
  const stores = useStores();
  // Only membership matters here, not title/description/activity changes.
  const memberIds = useStore(
    stores.conversations,
    (s) => s.byId[conversationId]?.memberIds ?? NONE,
  );
  const adminIds = useStore(stores.conversations, (s) => s.byId[conversationId]?.adminIds ?? NONE);
  const contacts = useStore(stores.contacts, (s) => s.byId);
  const onKeyDown = useRovingFocus('vertical');
  const sections = useMemo(
    () => buildMemberSections({ memberIds, adminIds }, contacts),
    [memberIds, adminIds, contacts],
  );
  const firstId = sections[0]?.members[0]?.id;
  return (
    <Scroller className={styles.list} onKeyDown={onKeyDown}>
      {sections.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h3 className={styles.heading}>
            {section.title} · {section.members.length}
          </h3>
          <ul>
            {section.members.map((contact) => (
              <MemberRow
                key={contact.id}
                contact={contact}
                conversationId={conversationId}
                tabStop={contact.id === firstId}
              />
            ))}
          </ul>
        </section>
      ))}
    </Scroller>
  );
}
