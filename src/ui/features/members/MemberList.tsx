import { useStore } from 'zustand';
import type { Contact, ConversationView } from '@/core/domain';
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
  conversation: Pick<ConversationView, 'memberIds' | 'adminIds'>,
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

export function MemberList({ conversation }: { conversation: ConversationView }) {
  const stores = useStores();
  const contacts = useStore(stores.contacts, (s) => s.byId);
  const onKeyDown = useRovingFocus('vertical');
  const sections = buildMemberSections(conversation, contacts);
  const firstId = sections[0]?.members[0]?.id;
  return (
    <Scroller className={styles.list} onKeyDown={onKeyDown}>
      {sections.map((section) => (
        <section key={section.title} aria-label={section.title}>
          <h3 className={styles.heading}>
            {section.title} — {section.members.length}
          </h3>
          <ul>
            {section.members.map((contact) => (
              <MemberRow
                key={contact.id}
                contact={contact}
                conversationId={conversation.id}
                tabStop={contact.id === firstId}
              />
            ))}
          </ul>
        </section>
      ))}
    </Scroller>
  );
}
