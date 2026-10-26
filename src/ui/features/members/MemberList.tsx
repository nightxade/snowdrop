import { UserPlus } from 'lucide-react';
import { useMemo } from 'react';
import { useStore } from 'zustand';
import { canAddMembers, canManageGroup, type Contact, type ConversationId } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { openGroupModal } from '@/ui/features/conversation';
import { useRovingFocus, useSnowdrop } from '@/ui/hooks';
import { Button, Scroller } from '@/ui/primitives';
import { MemberRow } from './MemberRow';
import { PendingRow } from './PendingRow';
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
  const app = useSnowdrop();
  const { stores } = app;
  // Only membership matters here, not title/description/activity changes.
  const memberIds = useStore(
    stores.conversations,
    (s) => s.byId[conversationId]?.memberIds ?? NONE,
  );
  const adminIds = useStore(stores.conversations, (s) => s.byId[conversationId]?.adminIds ?? NONE);
  const pendingIds = useStore(
    stores.conversations,
    (s) => s.byId[conversationId]?.pendingMemberIds ?? NONE,
  );
  const requestingIds = useStore(
    stores.conversations,
    (s) => s.byId[conversationId]?.requestingMemberIds ?? NONE,
  );
  const labels = useStore(stores.conversations, (s) => s.byId[conversationId]?.memberLabels);
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  // What our role may do, as Signal Desktop gates it (see core/domain/groups).
  const canAdd = useStore(stores.conversations, (s) =>
    canAddMembers(s.byId[conversationId], selfId),
  );
  const canManage = useStore(stores.conversations, (s) =>
    canManageGroup(s.byId[conversationId], selfId),
  );
  const contacts = useStore(stores.contacts, (s) => s.byId);
  const onKeyDown = useRovingFocus('vertical');
  const sections = useMemo(
    () => buildMemberSections({ memberIds, adminIds }, contacts),
    [memberIds, adminIds, contacts],
  );
  const firstId = sections[0]?.members[0]?.id;
  return (
    <Scroller className={styles.list} onKeyDown={onKeyDown}>
      {canAdd && (
        <Button
          className={styles.add}
          size="sm"
          fullWidth
          icon={<UserPlus size={14} />}
          onClick={() => {
            openGroupModal(app, 'addMembers', { conversationId });
          }}
        >
          Add members
        </Button>
      )}
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
                label={labels?.[contact.id]}
              />
            ))}
          </ul>
        </section>
      ))}
      {/* Admins answer requests; everyone can see who has been invited. */}
      {canManage && requestingIds.length > 0 && (
        <PendingSection
          title="Requests"
          ids={requestingIds}
          kind="request"
          contacts={contacts}
          conversationId={conversationId}
          canAct
        />
      )}
      {pendingIds.length > 0 && (
        <PendingSection
          title="Invited"
          ids={pendingIds}
          kind="invite"
          contacts={contacts}
          conversationId={conversationId}
          canAct={canManage}
        />
      )}
    </Scroller>
  );
}

function PendingSection({
  title,
  ids,
  kind,
  contacts,
  conversationId,
  canAct,
}: {
  title: string;
  ids: readonly string[];
  kind: 'request' | 'invite';
  contacts: Readonly<Record<string, Contact>>;
  conversationId: ConversationId;
  canAct: boolean;
}) {
  return (
    <section aria-label={title}>
      <h3 className={styles.heading}>
        {title} · {ids.length}
      </h3>
      <ul>
        {ids.map((id) => (
          <PendingRow
            key={id}
            id={id}
            contact={contacts[id]}
            kind={kind}
            conversationId={conversationId}
            canAct={canAct}
          />
        ))}
      </ul>
    </section>
  );
}
