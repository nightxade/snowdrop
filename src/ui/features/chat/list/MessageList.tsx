import {
  forwardRef,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { useStore } from 'zustand';
import type { ConversationId, MessageId, RenderItem } from '@/core/domain';
import { conversationsSelectors } from '@/core/stores';
import { setConversationListFocusResolver, useShellStyle, useSnowdrop } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { MessageItem } from '../message/MessageItem';
import { useRenderProbe } from '../lib/useRenderProbe';
import { BottomPin } from './bottomPin';
import { ConversationIntro } from './ConversationIntro';
import { DayDivider } from './DayDivider';
import { HistorySkeleton } from './HistorySkeleton';
import { JumpToPresent } from './JumpToPresent';
import { LiveAnnouncer } from './LiveAnnouncer';
import { NewDivider } from './NewDivider';
import { NewMessagesBar } from './NewMessagesBar';
import { prefetchEdges } from './prefetch';
import { RowState, RowStateProvider } from './rowState';
import { SystemRow } from './SystemRow';
import { useListItems } from './useListItems';
import { useListNavigation } from './useListNavigation';
import { useReadTracking } from './useReadTracking';
import styles from './MessageList.module.css';

interface ListContext {
  conversationId: ConversationId;
  title: string;
  compact: boolean;
  compactAvatars: boolean;
  hasMoreBefore: boolean;
  loaded: boolean;
  loading: boolean;
}

/** Items within this many rows of the end open at the bottom instead of at the divider. */
const DIVIDER_NEAR_END = 12;
const FLASH_MS = 1600;
/**
 * Typical row heights (measured medians in the demo). A close first guess
 * keeps prepended rows from shifting the view while they are measured.
 */
const ROW_HEIGHT = { comfortable: 62, compact: 28 } as const;
/** Gap above the divider / jump target, so it isn't flush with the top edge. */
const TOP_OFFSET = -48;

function reducedMotion(): boolean {
  const attr = document.documentElement.dataset.reducedMotion;
  if (attr === 'on') return true;
  if (attr === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The rows' container is a feed (articles a reader moves through), not a
 * live log: rows mounting while scrolling history must not be announced as
 * new. Arrivals are announced by <LiveAnnouncer>.
 */
const ListEl = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { context?: ListContext }
>(function ListEl({ context, children, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      role="feed"
      aria-busy={context?.loading ?? false}
      aria-label={context ? `Messages in ${context.title}` : 'Messages'}
      data-snowdrop="message-log"
    >
      {children}
    </div>
  );
});

const COMPONENTS: Components<RenderItem, ListContext> = {
  List: ListEl,
  Header: ({ context }) =>
    context.loaded && !context.hasMoreBefore ? (
      <ConversationIntro conversationId={context.conversationId} />
    ) : (
      <HistorySkeleton rows={context.loaded ? 3 : 8} />
    ),
  Footer: () => <div className={styles.footer} />,
};

/**
 * The virtualised, bottom-anchored message list. Older history prepends
 * without moving the view (firstItemIndex bookkeeping in useListItems);
 * jumps to old messages replace the window and remount at the target.
 * Subscribes only to the conversation's title, never its local state (the
 * draft changes on every keystroke).
 */
export function MessageList({ conversationId }: { conversationId: ConversationId }) {
  const app = useSnowdrop();
  const { stores, history } = app;
  const chat = useChatController();
  const title = useStore(stores.conversations, (s) => s.byId[conversationId]?.title ?? '');
  const model = useListItems(conversationId);
  const { items, firstItemIndex, epoch, loaded, loading, hasMoreBefore, anchoredToPresent } = model;
  // The TUI shell always shows one line per message, regardless of the
  // Message density setting (reusing compact mode's own markup and layout),
  // and never shows avatars.
  const tui = useShellStyle();
  const densityCompact = useStore(stores.settings, (s) => s.appearance.density === 'compact');
  const showAvatarsInCompact = useStore(stores.settings, (s) => s.appearance.showAvatarsInCompact);
  const compact = tui || densityCompact;
  const compactAvatars = !tui && showAvatarsInCompact;
  const unread = useStore(stores.conversations, conversationsSelectors.unread(conversationId));
  const virtuoso = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [pin] = useState(() => new BottomPin());
  useRenderProbe(null);
  // Starts false: a list opened at the unread divider must not count as "seen to the bottom".
  const [atBottom, setAtBottom] = useState(false);
  const [bottomEpoch, setBottomEpoch] = useState(epoch);
  if (bottomEpoch !== epoch) {
    // A remounted virtualiser reports its own bottom state afresh.
    setBottomEpoch(epoch);
    setAtBottom(false);
  }
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [target, setTarget] = useState<{ id: MessageId; flash: boolean; focus: boolean } | null>(
    null,
  );
  const [rows] = useState(() => new RowState());
  /** Where the unread divider is relative to the viewport (rendered rows include overscan). */
  const [dividerPos, setDividerPos] = useState<'above' | 'visible' | 'below'>('below');

  const atPresent = loaded && anchoredToPresent && atBottom;
  useReadTracking(conversationId, atPresent);

  const indexOf = useCallback(
    (id: MessageId) => items.findIndex((it) => 'id' in it && it.id === id),
    [items],
  );
  const dividerIndex = items.findIndex((it) => it.type === 'new-divider');

  // Where a freshly (re)mounted list starts: a jump target, the unread divider, or the bottom.
  const initialIndex = useMemo(() => {
    if (target) {
      const i = items.findIndex((it) => 'id' in it && it.id === target.id);
      if (i >= 0) return { index: i, align: 'center' as const };
    }
    if (dividerIndex >= 0 && items.length - dividerIndex > DIVIDER_NEAR_END)
      return { index: dividerIndex, align: 'start' as const, offset: TOP_OFFSET };
    return { index: 'LAST' as const, align: 'end' as const };
    // Only consulted when the list remounts (epoch); later item changes must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // Each (re)mount decides once whether to hold the bottom — never on later renders.
  useLayoutEffect(() => {
    pin.reset(initialIndex.index === 'LAST');
  }, [pin, initialIndex]);

  // The roving tab stop defaults to the newest message.
  useEffect(() => {
    const active = rows.activeId;
    if (active !== null && items.some((it) => 'id' in it && it.id === active)) return;
    const last = items.findLast((it) => it.type === 'message');
    if (last && 'id' in last) rows.setActive(last.id);
  }, [items, rows]);

  // The latest scheduled focus-after-scroll, so a second "jump to" within
  // 350ms can cancel the first one instead of letting it land on a stale row.
  const pendingFocus = useRef<{ id: MessageId; timer: ReturnType<typeof setTimeout> } | null>(null);

  // A pending jump whose target is now loaded: scroll to it, flash it, maybe focus it.
  useEffect(() => {
    if (!target) return;
    const index = indexOf(target.id);
    if (index < 0) return;
    const { id, flash, focus } = target;
    const frame = requestAnimationFrame(() => {
      virtuoso.current?.scrollToIndex({
        index,
        align: 'center',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
      if (flash) {
        rows.flash(id);
        setTimeout(() => {
          if (rows.isFlashing(id)) rows.flash(null);
        }, FLASH_MS);
      }
      if (focus) {
        rows.setActive(id);
        if (pendingFocus.current) clearTimeout(pendingFocus.current.timer);
        // After the (possibly smooth) scroll has rendered the row.
        const timer = setTimeout(() => {
          // Only focus if nothing superseded this jump in the meantime.
          if (pendingFocus.current?.timer !== timer) return;
          pendingFocus.current = null;
          scroller.current
            ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
            ?.focus({ preventScroll: true });
        }, 350);
        pendingFocus.current = { id, timer };
      }
      setTarget(null);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, indexOf, rows]);

  // Release a still-pending focus timer if the list unmounts first.
  useEffect(() => {
    return () => {
      if (pendingFocus.current) clearTimeout(pendingFocus.current.timer);
    };
  }, []);

  const scrollToBottom = useCallback(() => {
    virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, []);

  const jumpToPresent = useCallback(async () => {
    const w = stores.messages.getState().windows[conversationId];
    if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
    pin.onReachedBottom();
    requestAnimationFrame(scrollToBottom);
  }, [stores, history, conversationId, scrollToBottom, pin]);

  const reveal = useCallback(
    async (id: MessageId, options?: { flash?: boolean; focus?: boolean }) => {
      const next = { id, flash: options?.flash ?? true, focus: options?.focus ?? false };
      const w = stores.messages.getState().windows[conversationId];
      if (w && id in w.byId) {
        setTarget(next);
        return true;
      }
      // Set first, so the list remounting on the new window starts at the target.
      setTarget(next);
      const ok = await history.jumpTo(conversationId, id);
      if (!ok) {
        setTarget(null);
        stores.ui.getState().pushToast({
          message: "The original message isn't available on this device.",
          kind: 'info',
          source: 'core',
        });
      }
      return ok;
    },
    [stores, history, conversationId],
  );

  const navigation = useListNavigation({
    scroller,
    virtuoso,
    rows,
    jumpToPresent,
    loadOlder: () => {
      if (loaded && hasMoreBefore) void history.loadOlder(conversationId);
    },
    reducedMotion,
  });

  useEffect(
    () => chat.registerList({ ...navigation, conversationId, jumpToPresent, reveal }),
    [chat, conversationId, jumpToPresent, reveal, navigation],
  );

  // Navigating to this conversation (switcher, notification, vim J/K…) lands
  // on the message list's current row by default: reuse the roving tab stop
  // (the newest message, or the scroller itself when none is rendered yet).
  useEffect(
    () =>
      setConversationListFocusResolver((id) => {
        if (id !== conversationId) return null;
        navigation.focus();
        // `navigation.focus()` can be a no-op (the scroller itself hasn't
        // mounted yet — this runs on a rAF, before Virtuoso's rows do):
        // only report success if focus actually landed inside this list,
        // never whatever was focused before (possibly `<body>`), so a
        // caller can tell the difference and fall back or retry.
        const active = document.activeElement;
        return active instanceof HTMLElement && scroller.current?.contains(active) ? active : null;
      }),
    [conversationId, navigation],
  );

  // Latest-value refs for the stable scroller callbacks below.
  const measureRef = useRef<() => void>(() => undefined);
  const repinRef = useRef<() => void>(() => undefined);
  const firstRendered = useRef(0);
  const measureDivider = () => {
    const el = scroller.current;
    const divider = el?.querySelector('[data-snowdrop="new-divider"]');
    let pos: 'above' | 'visible' | 'below';
    if (el && divider) {
      const view = el.getBoundingClientRect();
      const box = divider.getBoundingClientRect();
      pos = box.bottom < view.top ? 'above' : box.top > view.bottom ? 'below' : 'visible';
    } else {
      pos = dividerIndex >= 0 && dividerIndex < firstRendered.current ? 'above' : 'below';
    }
    setDividerPos(pos);
  };
  const repin = () => {
    if (pin.shouldRepin() && anchoredToPresent) scrollToBottom();
  };
  useEffect(() => {
    measureRef.current = measureDivider;
    repinRef.current = repin;
  });

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    pin.onScroll(distance);
    setFarFromBottom(distance > el.clientHeight);
    measureRef.current();
  }, [pin]);

  // When no rendered row holds the roving tab stop, the scroller itself takes Tab.
  useEffect(
    () =>
      rows.subscribe(() => {
        if (scroller.current) scroller.current.tabIndex = rows.activeMounted ? -1 : 0;
      }),
    [rows],
  );

  /**
   * Stable: Virtuoso calls this again whenever the function identity changes,
   * and per-render reattachment used to reset the bottom pin (yanking a
   * reader who had scrolled up back down).
   */
  const resize = useRef<ResizeObserver | null>(null);
  const scrollerRef = useCallback(
    (el: HTMLElement | Window | null) => {
      const node = el instanceof HTMLElement ? el : null;
      if (scroller.current === node) return;
      scroller.current?.removeEventListener('scroll', onScroll);
      resize.current?.disconnect();
      resize.current = null;
      scroller.current = node;
      if (!node) return;
      node.tabIndex = rows.activeMounted ? -1 : 0;
      // Stable hook for keyboard layers ("focus is on the message list").
      node.setAttribute('data-message-scroller', '');
      node.addEventListener('scroll', onScroll, { passive: true });
      // The viewport shrinks when the composer grows (reply bar, more lines,
      // attachments): keep the newest message in view if we were holding it.
      let height = node.clientHeight;
      if (typeof ResizeObserver !== 'undefined') {
        resize.current = new ResizeObserver(() => {
          if (node.clientHeight === height) return;
          height = node.clientHeight;
          repinRef.current();
        });
        resize.current.observe(node);
      }
    },
    [onScroll, rows],
  );
  useEffect(
    () => () => {
      resize.current?.disconnect();
    },
    [],
  );

  const context: ListContext = {
    conversationId,
    title,
    compact,
    compactAvatars,
    hasMoreBefore,
    loaded,
    loading,
  };

  /** ↑/↓ move between messages; from the scroller itself they step into the newest visible one. */
  const onRowKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!(e.target instanceof HTMLElement)) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-roving-item]')];
    let next: HTMLElement | undefined;
    if (e.target === scroller.current) {
      next = e.key === 'ArrowUp' ? all.at(-1) : all[0];
    } else if (e.target.hasAttribute('data-roving-item')) {
      const i = all.indexOf(e.target);
      next = all[e.key === 'ArrowUp' ? i - 1 : i + 1];
      if (!next && e.key === 'ArrowUp') scroller.current?.scrollBy({ top: -200 });
    } else {
      return;
    }
    e.preventDefault();
    if (next) {
      const id = next.dataset.messageId as MessageId | undefined;
      if (id) rows.setActive(id);
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    }
  };

  return (
    <RowStateProvider value={rows}>
      <div
        className={styles.wrap}
        onKeyDown={onRowKeys}
        onPointerLeave={() => {
          rows.setHovered(null);
        }}
      >
        <NewMessagesBar
          conversationId={conversationId}
          dividerLoaded={dividerIndex >= 0}
          dividerAbove={dividerPos === 'above'}
          dividerVisible={dividerPos === 'visible'}
          onJump={() => {
            if (dividerIndex >= 0)
              virtuoso.current?.scrollToIndex({
                index: dividerIndex,
                align: 'start',
                offset: TOP_OFFSET,
                behavior: reducedMotion() ? 'auto' : 'smooth',
              });
            else void jumpToFirstUnread();
          }}
        />
        <Virtuoso<RenderItem, ListContext>
          key={epoch}
          ref={virtuoso}
          className={styles.list}
          data={items}
          context={context}
          firstItemIndex={firstItemIndex}
          initialTopMostItemIndex={initialIndex}
          computeItemKey={(_, item) => item.key}
          alignToBottom
          atBottomThreshold={48}
          increaseViewportBy={{ top: 800, bottom: 400 }}
          defaultItemHeight={compact ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable}
          skipAnimationFrameInResizeObserver
          followOutput={() =>
            pin.isStuck && anchoredToPresent ? (reducedMotion() ? 'auto' : 'smooth') : false
          }
          atBottomStateChange={(bottom) => {
            if (bottom) pin.onReachedBottom();
            setAtBottom(bottom);
          }}
          totalListHeightChanged={repin}
          rangeChanged={(range) => {
            firstRendered.current = range.startIndex - firstItemIndex;
            measureDivider();
            if (!loaded) return;
            const decision = prefetchEdges(range, firstItemIndex, items.length, {
              hasMoreBefore,
              anchoredToPresent,
            });
            if (decision.loadOlder) void history.loadOlder(conversationId);
            if (decision.loadNewer) void history.loadNewer(conversationId);
          }}
          // Backstops rangeChanged's prefetch for a fling fast enough to skip
          // straight past the threshold in one jump (both are coalescing, so
          // calling both here costs nothing extra).
          startReached={() => {
            if (loaded && hasMoreBefore) void history.loadOlder(conversationId);
          }}
          endReached={() => {
            if (loaded && !anchoredToPresent) void history.loadNewer(conversationId);
          }}
          scrollerRef={scrollerRef}
          components={COMPONENTS}
          itemContent={(_, item, ctx) => <Row item={item} context={ctx} />}
        />
        <JumpToPresent
          visible={loaded && (!anchoredToPresent || farFromBottom)}
          count={atPresent ? 0 : unread.count}
          onJump={() => {
            void jumpToPresent();
            chat.focusComposer();
          }}
        />
        <LiveAnnouncer conversationId={conversationId} />
      </div>
    </RowStateProvider>
  );

  async function jumpToFirstUnread(): Promise<void> {
    const marker = stores.ui.getState().unreadMarkers[conversationId];
    if (marker === undefined) return;
    const id = await history.jumpToFirstUnread(
      conversationId,
      marker,
      stores.session.getState().self?.id ?? null,
    );
    if (id) setTarget({ id, flash: false, focus: false });
  }
}

function Row({ item, context }: { item: RenderItem; context: ListContext }) {
  switch (item.type) {
    case 'day-divider':
      return <DayDivider at={item.at} />;
    case 'new-divider':
      return <NewDivider />;
    case 'system':
      return <SystemRow conversationId={context.conversationId} id={item.id} />;
    case 'message':
      return (
        <div
          className={styles.item}
          data-group-start={item.continuation ? undefined : ''}
          data-compact={context.compact ? '' : undefined}
        >
          <MessageItem
            conversationId={context.conversationId}
            id={item.id}
            continuation={item.continuation}
            compact={context.compact}
            compactAvatars={context.compactAvatars}
          />
        </div>
      );
  }
}
