import { Inbox } from 'lucide-react';
import { Fragment, useId, useState } from 'react';
import { useStore } from 'zustand';
import { HOME, sessionSelectors, type HomeSection } from '@/core/stores';
import { useRovingFocus, useStores } from '@/ui/hooks';
import { EmptyState, Scroller, Skeleton } from '@/ui/primitives';
import { CategoryHeader } from './CategoryHeader';
import { ConversationRow } from './ConversationRow';
import { useCategoryDrop } from './useCategoryDrop';
import { visibleIds } from './model';
import { SectionHeader } from './SectionHeader';
import { useSidebarModel } from './useSidebarModel';
import styles from './ConversationList.module.css';

export function ConversationList() {
  const stores = useStores();
  const ready = useStore(stores.session, sessionSelectors.ready);
  // Collapsed sections only need *which* conversations are unread, not the
  // counts; a joined key keeps the list from re-rendering on every message.
  const unreadKey = useStore(stores.conversations, (s) =>
    Object.keys(s.unread)
      .filter((id) => (s.unread[id as keyof typeof s.unread]?.count ?? 0) > 0)
      .sort()
      .join('\n'),
  );
  const unread: Record<string, { count: number; mentions: number }> = {};
  for (const id of unreadKey ? unreadKey.split('\n') : []) unread[id] = { count: 1, mentions: 0 };
  const { space, sections, archived, selected, catchingUp } = useSidebarModel();
  const onKeyDown = useRovingFocus('vertical');
  const [showArchived, setShowArchived] = useState(false);
  const baseId = useId();
  const drop = useCategoryDrop(space);
  const viewsById = useStore(stores.conversations, (s) => s.byId);

  if (!ready) return <ListSkeleton />;

  const variant = space === HOME ? 'home' : 'channel';
  const rows = sections.map((section) => ({
    section,
    ids: visibleIds(section, selected, unread),
  }));
  // Exactly one row is reachable by Tab: the open conversation, else the first row.
  const allIds = rows.flatMap((r) => r.ids);
  const tabStop = selected && allIds.includes(selected) ? selected : allIds[0];

  const toggle = (sectionId: string) => {
    if (space === HOME) stores.spaces.getState().toggleHomeSection(sectionId as HomeSection);
    else stores.spaces.getState().toggleCategory(space, sectionId);
  };

  const isEmpty = sections.every((s) => s.ids.length === 0) && archived.length === 0;

  return (
    <Scroller className={styles.scroller} data-snowdrop="conversation-list">
      <nav
        aria-label={space === HOME ? 'Home conversations' : 'Space conversations'}
        aria-busy={catchingUp}
        onKeyDown={onKeyDown}
      >
        {isEmpty && (
          <EmptyState size="sm" icon={<Inbox />} title="Nothing here yet">
            {space === HOME
              ? 'Conversations appear here as soon as someone messages you.'
              : 'Move a group here with right-click → Move to space.'}
          </EmptyState>
        )}
        {rows.map(({ section, ids }) => {
          const listId = `${baseId}-${section.id}`;
          const inSpace = space !== HOME;
          const line =
            inSpace && drop.indicator?.categoryId === section.id ? drop.indicator.index : -1;
          const dropLine = <li key="__drop" className={styles.dropLine} aria-hidden />;
          return (
            <section
              key={section.id}
              className={styles.section}
              aria-label={section.title}
              data-drop-active={line !== -1 ? '' : undefined}
              {...(inSpace ? drop.handlers(section.id, ids) : {})}
            >
              {inSpace ? (
                <CategoryHeader
                  spaceId={space}
                  categoryId={section.id}
                  title={section.title}
                  collapsed={section.collapsed}
                  controls={listId}
                  onToggle={() => {
                    toggle(section.id);
                  }}
                />
              ) : (
                <SectionHeader
                  title={section.title}
                  collapsed={section.collapsed}
                  controls={listId}
                  onToggle={() => {
                    toggle(section.id);
                  }}
                />
              )}
              <ul id={listId} className={styles.list}>
                {ids.map((id, i) => (
                  // Keyed on `id` alone (not wrapped per-index): a conversation keeps the
                  // same identity — and so the same mounted row, with its own render
                  // state (CatchUpTracker's frozen unread badge) — across reorders, e.g.
                  // when a new conversation is inserted ahead of it while catching up.
                  <Fragment key={id}>
                    {i === line && dropLine}
                    <ConversationRow
                      id={id}
                      variant={variant}
                      selected={id === selected}
                      tabStop={id === tabStop}
                      // Spaces: drag between categories or to another space. Home: groups to a space.
                      draggable={inSpace || viewsById[id]?.kind === 'group'}
                    />
                  </Fragment>
                ))}
                {line === ids.length && dropLine}
                {inSpace && ids.length === 0 && !section.collapsed && line === -1 && (
                  <li className={styles.emptyCategory}>
                    Drag conversations here, or use ⋯ → Move to category
                  </li>
                )}
              </ul>
            </section>
          );
        })}
        {archived.length > 0 && (
          <section className={styles.section} aria-label="Archived">
            <SectionHeader
              title={`Archived · ${archived.length}`}
              collapsed={!showArchived}
              controls={`${baseId}-archived`}
              onToggle={() => {
                setShowArchived((v) => !v);
              }}
            />
            <ul id={`${baseId}-archived`} className={styles.list}>
              {showArchived &&
                archived.map((id) => (
                  <ConversationRow
                    key={id}
                    id={id}
                    variant="home"
                    selected={id === selected}
                    tabStop={false}
                  />
                ))}
            </ul>
          </section>
        )}
      </nav>
    </Scroller>
  );
}

function ListSkeleton() {
  return (
    <div className={styles.skeleton} aria-busy="true" aria-label="Loading conversations">
      <Skeleton width={96} height={10} />
      {[0.72, 0.55, 0.8, 0.62, 0.48, 0.7, 0.58].map((w, i) => (
        <div key={i} className={styles.skeletonRow}>
          <Skeleton width={32} height={32} radius="full" />
          <div className={styles.skeletonText}>
            <Skeleton width={`${w * 100}%`} height={10} />
            <Skeleton width={`${w * 70}%`} height={8} />
          </div>
        </div>
      ))}
    </div>
  );
}
