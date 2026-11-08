import { UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { canAddMembers, canManageGroup, type Contact, type ConversationId } from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { openGroupModal } from '@/ui/features/conversation';
import { useRovingFocus, useSnowdrop } from '@/ui/hooks';
import { Button, Scroller } from '@/ui/primitives';
import {
  VIRTUAL_THRESHOLD,
  VirtualList,
  type VirtualListHandle,
} from '@/ui/primitives/VirtualList';
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

type WindowRow =
  | { type: 'heading'; key: string; text: string }
  | { type: 'member'; key: string; contact: Contact }
  | { type: 'pending'; key: string; id: string; kind: 'request' | 'invite'; canAct: boolean };

/** Every row of the list in order, flat, for the windowed version of a long one. */
function windowRows(
  sections: readonly MemberSection[],
  pending: readonly {
    title: string;
    ids: readonly string[];
    kind: 'request' | 'invite';
    canAct: boolean;
  }[],
): WindowRow[] {
  const rows: WindowRow[] = [];
  for (const section of sections) {
    rows.push({
      type: 'heading',
      key: `h:${section.title}`,
      text: `${section.title} · ${section.members.length}`,
    });
    for (const contact of section.members) {
      rows.push({ type: 'member', key: `m:${contact.id}`, contact });
    }
  }
  for (const group of pending) {
    if (group.ids.length === 0) continue;
    rows.push({
      type: 'heading',
      key: `h:${group.title}`,
      text: `${group.title} · ${group.ids.length}`,
    });
    for (const id of group.ids) {
      rows.push({
        type: 'pending',
        key: `p:${group.kind}:${id}`,
        id,
        kind: group.kind,
        canAct: group.canAct,
      });
    }
  }
  return rows;
}

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
  const requests = canManage ? requestingIds : NONE;
  const total =
    sections.reduce((n, section) => n + section.members.length + 1, 0) +
    requests.length +
    pendingIds.length;
  const windowed = total > VIRTUAL_THRESHOLD;
  const rows = useMemo(
    () =>
      windowed
        ? windowRows(sections, [
            { title: 'Requests', ids: requests, kind: 'request', canAct: true },
            { title: 'Invited', ids: pendingIds, kind: 'invite', canAct: canManage },
          ])
        : [],
    [windowed, sections, requests, pendingIds, canManage],
  );
  const handle = useRef<VirtualListHandle | null>(null);
  const container = useRef<HTMLDivElement | null>(null);
  const [lastFocused, setLastFocused] = useState<string | null>(null);
  /** The member row that has (or last had) focus, kept across its unmounting. */
  const focusedId = useRef<string | null>(null);
  /** The rows the list has mounted (overscan included), once it has said. */
  const [range, setRange] = useState<{ first: number; last: number } | null>(null);
  // Exactly one row is the tab stop, and it is always one that is mounted:
  // where the user was if that row still is, else the first member row shown.
  const mountedMember = (id: string | null): boolean => {
    if (id === null || !contacts[id] || !memberIds.includes(id)) return false;
    if (range === null) return true;
    const at = rows.findIndex((row) => row.type === 'member' && row.contact.id === id);
    return at >= range.first && at <= range.last;
  };
  const firstShown =
    range === null
      ? firstId
      : rows
          .slice(range.first, range.last + 1)
          .flatMap((row) => (row.type === 'member' ? [row.contact.id] : []))[0];
  const tabStopId = mountedMember(lastFocused) ? lastFocused : (firstShown ?? firstId);
  const onRange = useCallback((first: number, last: number) => {
    setRange((prev) => (prev?.first === first && prev.last === last ? prev : { first, last }));
  }, []);
  // The row that had focus scrolled out and was unmounted: focus would fall to
  // the page, so keep it on the list (arrow keys then resume from its top).
  useEffect(() => {
    const list = container.current;
    if (!windowed || !list) return;
    const observer = new MutationObserver(() => {
      const id = focusedId.current;
      if (
        id !== null &&
        (document.activeElement === document.body || document.activeElement === null) &&
        !list.querySelector(`[data-member-id="${CSS.escape(id)}"]`)
      ) {
        list.focus({ preventScroll: true });
        focusedId.current = null;
      }
    });
    observer.observe(list, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  }, [windowed]);
  /** Home and End in a windowed list: the end row is not mounted yet, so scroll to it, then focus it. */
  const onWindowedKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      const plain = !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey);
      if (plain && (event.key === 'Home' || event.key === 'End')) {
        const members = rows.flatMap((row, index) =>
          row.type === 'member' ? [{ index, id: row.contact.id }] : [],
        );
        const end = event.key === 'Home' ? members[0] : members.at(-1);
        if (end && event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.preventDefault();
          handle.current?.scrollToIndex(end.index, 'center');
          const list = event.currentTarget;
          let frames = 0;
          const focusWhenMounted = () => {
            const row = list.querySelector<HTMLElement>(`[data-member-id="${CSS.escape(end.id)}"]`);
            if (row) row.focus();
            else if (++frames < 30) requestAnimationFrame(focusWhenMounted);
          };
          requestAnimationFrame(focusWhenMounted);
          return;
        }
      }
      onKeyDown(event);
    },
    [rows, onKeyDown],
  );
  if (windowed) {
    return (
      <div
        ref={container}
        className={styles.windowed}
        tabIndex={-1}
        onKeyDown={onWindowedKeyDown}
        onFocusCapture={(event) => {
          const id =
            event.target instanceof HTMLElement ? event.target.dataset['memberId'] : undefined;
          if (id) {
            focusedId.current = id;
            setLastFocused(id);
          }
        }}
        onBlurCapture={(event) => {
          // Focus really left (it went elsewhere, and the row is still there),
          // as opposed to the row being unmounted under it.
          const row = event.target;
          queueMicrotask(() => {
            if (row instanceof HTMLElement && row.isConnected && document.activeElement !== row) {
              if (focusedId.current === row.dataset['memberId']) focusedId.current = null;
            }
          });
        }}
      >
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
        <VirtualList
          tag="ul"
          aria-label="Members"
          className={styles.virtual}
          handleRef={handle}
          onRange={onRange}
          count={rows.length}
          rowHeight={42}
          maxHeight="calc(100dvh - 2 * var(--snowdrop-header-height))"
          itemKey={(index) => rows[index]?.key ?? String(index)}
          itemContent={(index) => {
            const row = rows[index];
            if (!row) return null;
            if (row.type === 'heading') return <h3 className={styles.heading}>{row.text}</h3>;
            if (row.type === 'member') {
              return (
                <MemberRow
                  bare
                  contact={row.contact}
                  conversationId={conversationId}
                  tabStop={row.contact.id === tabStopId}
                  label={labels?.[row.contact.id]}
                />
              );
            }
            return (
              <PendingRow
                bare
                id={row.id}
                contact={contacts[row.id]}
                kind={row.kind}
                conversationId={conversationId}
                canAct={row.canAct}
              />
            );
          }}
        />
      </div>
    );
  }
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
