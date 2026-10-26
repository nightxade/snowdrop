import { AudioLines, FileText, Image as ImageIcon, Link as LinkIcon, X } from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import {
  galleryItemsOf,
  groupGalleryByDate,
  type ConversationView,
  type GalleryItem,
  type GalleryKind,
} from '@/core/domain';
import { sessionSelectors } from '@/core/stores';
import { useSnowdrop } from '@/ui/hooks';
import { Button, EmptyState, IconButton, Skeleton } from '@/ui/primitives';
import { useChatController } from '../ChatController';
import { useMinuteClock } from '../lib/useMinuteClock';
import { AudioRows, FileRows, LinkRows } from './GalleryRows';
import { MediaGrid } from './MediaGrid';
import { useGallery, type GalleryTabState } from './useGallery';
import { useItemMeta } from './useItemMeta';
import styles from './GalleryPanel.module.css';

type AttachmentItem = Extract<GalleryItem, { type: 'attachment' }>;

// The viewer (and the Lightbox under it) is fetched the first time a photo opens.
const GalleryViewer = lazy(() =>
  import('./GalleryViewer').then((m) => ({ default: m.GalleryViewer })),
);

/** Desktop's tab order. */
const TABS: readonly { kind: GalleryKind; label: string }[] = [
  { kind: 'media', label: 'Media' },
  { kind: 'audio', label: 'Audio' },
  { kind: 'links', label: 'Links' },
  { kind: 'files', label: 'Files' },
];

const EMPTY: Record<GalleryKind, { title: string; body: string; icon: typeof ImageIcon }> = {
  media: {
    title: 'No media',
    body: 'Photos, videos, and GIFs that you send and receive will appear here',
    icon: ImageIcon,
  },
  audio: {
    title: 'No audio',
    body: 'Voice messages and audio files that you send and receive will appear here',
    icon: AudioLines,
  },
  links: {
    title: 'No links',
    body: 'Links that you send and receive will appear here',
    icon: LinkIcon,
  },
  files: {
    title: 'No files',
    body: 'Files that you send and receive will appear here',
    icon: FileText,
  },
};

/**
 * "Media, files & links": everything shared in this conversation, by type,
 * newest first and grouped by date as Signal Desktop does. Reads this
 * device's stored history a page at a time; every item can take you to its
 * message.
 */
export function GalleryPanel({
  conversation,
  onClose,
  closeOnJump = false,
}: {
  conversation: ConversationView;
  onClose: () => void;
  /** Narrow layouts show this over the chat, so a jump has to get out of the way. */
  closeOnJump?: boolean;
}) {
  const { stores } = useSnowdrop();
  const chat = useChatController();
  const importing = useStore(
    stores.session,
    (s) => sessionSelectors.historyImport(s).status === 'importing',
  );
  const { tabs, loadMore } = useGallery(conversation.id);
  const [kind, setKind] = useState<GalleryKind>('media');
  const describe = useItemMeta();
  const describeItem = (item: GalleryItem) => describe(item.message);
  const now = useMinuteClock();
  const tab = tabs[kind];
  const tablist = useRef<HTMLDivElement>(null);

  // A tab only loads once it is looked at.
  useEffect(() => {
    if (!tabs[kind].started) loadMore(kind);
  }, [kind, tabs, loadMore]);

  const items = useMemo(
    () => tab.messages.flatMap((m) => galleryItemsOf(m, kind)),
    [tab.messages, kind],
  );
  const sections = useMemo(() => groupGalleryByDate(items, now), [items, now]);
  const mediaItems = useMemo(
    () =>
      kind === 'media'
        ? sections
            .flatMap((s) => s.items)
            .filter((i): i is AttachmentItem => i.type === 'attachment')
        : [],
    [sections, kind],
  );

  const loadCurrent = useCallback(() => {
    loadMore(kind);
  }, [loadMore, kind]);

  const jump = useCallback(
    (item: GalleryItem) => {
      void chat.reveal(conversation.id, item.message.id, { focus: true });
      if (closeOnJump) onClose();
    },
    [chat, conversation.id, closeOnJump, onClose],
  );

  // The Lightbox, mounted on first open and then kept (unmounting an open Radix dialog can leave the page inert).
  const [viewer, setViewer] = useState<number | null>(null);
  const [viewerMounted, setViewerMounted] = useState(false);
  if (viewer !== null && !viewerMounted) setViewerMounted(true);
  const openViewer = useCallback(
    (item: AttachmentItem) => {
      setViewer(
        Math.max(
          0,
          mediaItems.findIndex((i) => i.key === item.key),
        ),
      );
    },
    [mediaItems],
  );
  const stepViewer = (index: number) => {
    setViewer(index);
    // Near the end of what is loaded: fetch the next page so stepping carries on.
    if (index >= mediaItems.length - 3) loadMore('media');
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    const at = TABS.findIndex((t) => t.kind === kind);
    let next: number;
    if (delta) next = (at + delta + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (!target) return;
    setKind(target.kind);
    tablist.current?.querySelector<HTMLElement>(`[data-tab="${target.kind}"]`)?.focus();
  };

  return (
    <aside
      className={styles.panel}
      aria-label="Media, files and links"
      data-snowdrop="gallery-panel"
      data-pane-title="media"
      onKeyDown={(e) => {
        // Esc closes, unless it was meant for something opened from here (the viewer, a menu).
        if (
          e.key === 'Escape' &&
          !e.defaultPrevented &&
          e.target instanceof Node &&
          e.currentTarget.contains(e.target)
        ) {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <header className={styles.header}>
        <h2 className={styles.title}>Media, files &amp; links</h2>
        <IconButton label="Close media (Esc)" icon={<X />} onClick={onClose} />
      </header>
      <div
        ref={tablist}
        className={styles.tabs}
        role="tablist"
        aria-label="Kind of item"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((t) => (
          <button
            key={t.kind}
            type="button"
            role="tab"
            id={`gallery-tab-${t.kind}`}
            data-tab={t.kind}
            aria-selected={t.kind === kind}
            aria-controls={`gallery-panel-${t.kind}`}
            tabIndex={t.kind === kind ? 0 : -1}
            className={styles.tab}
            onClick={() => {
              setKind(t.kind);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {importing && (
        <p className={styles.importHint} role="status">
          Still importing your phone's message history. Older items may be missing until it
          finishes.
        </p>
      )}
      <div
        key={kind}
        className={styles.body}
        role="tabpanel"
        id={`gallery-panel-${kind}`}
        aria-labelledby={`gallery-tab-${kind}`}
        aria-busy={tab.loading && items.length === 0}
      >
        <TabContent kind={kind} tab={tab} hasItems={items.length > 0} onLoadMore={loadCurrent}>
          {kind === 'media' ? (
            <MediaGrid
              conversationId={conversation.id}
              sections={sections}
              describe={describeItem}
              onOpen={openViewer}
              onJump={jump}
            />
          ) : kind === 'audio' ? (
            <AudioRows
              conversationId={conversation.id}
              sections={sections}
              describe={describeItem}
              onJump={jump}
            />
          ) : kind === 'files' ? (
            <FileRows
              conversationId={conversation.id}
              sections={sections}
              describe={describeItem}
              onJump={jump}
            />
          ) : (
            <LinkRows
              conversationId={conversation.id}
              sections={sections}
              describe={describeItem}
              onJump={jump}
            />
          )}
        </TabContent>
      </div>
      {mediaItems.length > 0 && viewerMounted && (
        <Suspense fallback={null}>
          <GalleryViewer
            conversationId={conversation.id}
            items={mediaItems}
            index={Math.min(viewer ?? 0, mediaItems.length - 1)}
            open={viewer !== null}
            describe={describeItem}
            onIndexChange={stepViewer}
            onOpenChange={(o) => {
              if (!o) setViewer(null);
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

function TabContent({
  kind,
  tab,
  hasItems,
  onLoadMore,
  children,
}: {
  kind: GalleryKind;
  tab: GalleryTabState;
  hasItems: boolean;
  onLoadMore: () => void;
  children: ReactNode;
}) {
  if (!hasItems) {
    if (tab.failed)
      return (
        <EmptyState
          size="sm"
          title="Couldn't load this tab"
          action={
            <Button size="sm" variant="secondary" onClick={onLoadMore}>
              Try again
            </Button>
          }
        >
          Your stored history couldn't be read.
        </EmptyState>
      );
    if (!tab.started || tab.loading || !tab.done) return <Loading kind={kind} />;
    const empty = EMPTY[kind];
    const Icon = empty.icon;
    return (
      <EmptyState size="sm" icon={<Icon />} title={empty.title}>
        {empty.body}
      </EmptyState>
    );
  }
  return (
    <>
      {children}
      <MoreSentinel tab={tab} onLoadMore={onLoadMore} />
    </>
  );
}

function Loading({ kind }: { kind: GalleryKind }) {
  return kind === 'media' ? (
    <div className={styles.loadingGrid} aria-hidden>
      {Array.from({ length: 12 }, (_, i) => (
        <Skeleton key={i} height="auto" radius="sm" className={styles.square} />
      ))}
    </div>
  ) : (
    <div className={styles.loadingRows} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} height={48} radius="sm" />
      ))}
    </div>
  );
}

/**
 * The end of what is loaded. Scrolling it into view fetches the next page; the
 * button does the same for anyone who would rather ask (and where there is no
 * observer to scroll for).
 */
function MoreSentinel({ tab, onLoadMore }: { tab: GalleryTabState; onLoadMore: () => void }) {
  const end = useRef<HTMLDivElement>(null);
  const count = tab.messages.length;
  useEffect(() => {
    const el = end.current;
    if (!el || tab.done || tab.loading || tab.failed || typeof IntersectionObserver === 'undefined')
      return;
    // A fresh observer reports the current position at once, so a page that
    // left the end still in view loads the next without waiting for a scroll.
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) onLoadMore();
      },
      { rootMargin: '0px 0px 240px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
    };
    // `count` re-arms the observer after every page.
  }, [count, tab.done, tab.loading, tab.failed, onLoadMore]);
  if (tab.done) return null;
  return (
    <div ref={end} className={styles.more}>
      {tab.failed ? (
        <>
          <span>Couldn't load more.</span>
          <Button size="sm" variant="secondary" onClick={onLoadMore}>
            Try again
          </Button>
        </>
      ) : tab.loading ? (
        <span role="status">Loading…</span>
      ) : (
        <Button size="sm" variant="ghost" onClick={onLoadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}
