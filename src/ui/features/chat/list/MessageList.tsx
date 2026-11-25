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
import { conversationsSelectors, sessionSelectors } from '@/core/stores';
import {
  neighbourOf,
  setConversationListFocusResolver,
  useShellStyle,
  useSnowdrop,
} from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { MessageItem } from '../message/MessageItem';
import { useRenderProbe } from '../lib/useRenderProbe';
import { BottomPin, PIN_SLACK_PX } from './bottomPin';
import { ConversationIntro } from './ConversationIntro';
import { DayDivider } from './DayDivider';
import { HistorySkeleton } from './HistorySkeleton';
import { JumpToPresent } from './JumpToPresent';
import { LiveAnnouncer } from './LiveAnnouncer';
import { NewDivider } from './NewDivider';
import { NewMessagesBar } from './NewMessagesBar';
import { prefetchEdges } from './prefetch';
import { ReadingAnchor } from './readingAnchor';
import { RowState, RowStateProvider } from './rowState';
import { SystemRow } from './SystemRow';
import { useListItems } from './useListItems';
import { useJumpTarget } from './useJumpTarget';
import { useListNavigation } from './useListNavigation';
import { useReadTracking } from './useReadTracking';
import { useArrivalsBelow } from './useArrivalsBelow';
import { useFollowOwnSend } from './useFollowOwnSend';
import { useScrollerBinding } from './useScrollerBinding';
import { useUnreadDivider } from './useUnreadDivider';
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
/**
 * Typical row heights (measured medians in the demo). A close first guess
 * keeps prepended rows from shifting the view while they are measured.
 */
const ROW_HEIGHT = { comfortable: 62, compact: 28 } as const;
/** Gap above the divider / jump target, so it isn't flush with the top edge. */
const TOP_OFFSET = -48;
/**
 * How far (px) below the visible area the newest message's bottom may be and still count as seen.
 * "At the bottom" for following and for auto-reading arrivals is looser (the follow slack, C1); a
 * chat that already has unread messages is marked read only once the reader has really reached its
 * end (C7).
 */
const NEWEST_SEEN_PX = 4;
/** How many animation frames after a send completes focus lost with its swapped row may be handed to the sent row. */
const RESTORE_FOCUS_FRAMES = 20;

/**
 * How far (px) the bottom of the newest row is below the scroller's visible area. Measured on the
 * rendered list, not the scroll end: what follows the list (its footer, the TUI shell's padding) is
 * not a message, and the list's own scroll to the end can leave part of it out of view.
 */
function newestRowBelow(el: HTMLElement): number {
  const log = el.querySelector('[data-snowdrop="message-log"]');
  if (!log) return el.scrollHeight - el.scrollTop - el.clientHeight;
  const visibleBottom = el.getBoundingClientRect().top + el.clientTop + el.clientHeight;
  return log.getBoundingClientRect().bottom - visibleBottom;
}

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
  const [pin] = useState(() => new BottomPin());
  const [anchor] = useState(() => new ReadingAnchor());
  useRenderProbe(null);
  // Starts false: a list opened at the unread divider must not count as "seen to the bottom".
  const [atBottom, setAtBottom] = useState(false);
  // The mount (epoch) in which the reader released the list from where it opened (see BottomPin).
  const [releasedEpoch, setReleasedEpoch] = useState<number | null>(null);
  // Whether the end of the list is on screen (not merely within the follow slack of it). Measured
  // afresh after a remount, like `atBottom`.
  const [atEnd, setAtEnd] = useState(true);
  const [bottomEpoch, setBottomEpoch] = useState(epoch);
  if (bottomEpoch !== epoch) {
    // A remounted virtualiser reports its own bottom state afresh.
    setBottomEpoch(epoch);
    setAtBottom(false);
    setAtEnd(false);
  }
  const [farFromBottom, setFarFromBottom] = useState(false);
  // Also after the list grows, shrinks or is resized without scrolling (rows measured, a message
  // deleted): the end can come on screen, or go off it, without a scroll event.
  const measureEnd = () => {
    const el = scroller.current;
    if (el) setAtEnd(newestRowBelow(el) <= NEWEST_SEEN_PX);
  };
  // Half the visible height (see `slackFor`), shared by the pin and Virtuoso's at-bottom.
  const [slack, setSlack] = useState(PIN_SLACK_PX);
  const measureSlack = (el: HTMLElement) => {
    pin.setViewportHeight(el.clientHeight);
    setSlack(pin.slackPx);
  };
  const [rows] = useState(() => new RowState());
  // Rows above a reader who has scrolled up change size (a reaction, an edit, a delete): the
  // message being read stays put. A list pinned to the bottom, or held where it opened, has its
  // own rules (the pin, the divider).
  const holdReader = () => {
    const el = scroller.current;
    if (!el) return;
    if (pin.isStuck || pin.isHeldAway) {
      anchor.rebaseSoon(el, firstItemIndex);
      return;
    }
    anchor.hold(el, firstItemIndex);
  };

  useEffect(
    () => () => {
      anchor.dispose();
    },
    [anchor],
  );

  const scrollToBottom = useCallback(() => {
    virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, []);
  const repin = () => {
    if (!pin.shouldRepin() || !anchoredToPresent) return;
    pin.beginFollow(scrollTopNow());
    scrollToBottom();
  };
  // The older page a list held at the unread divider has not requested yet (see `holdsOlder`).
  const olderDeferred = useRef(false);
  const loadDeferredOlder = () => {
    if (!olderDeferred.current) return;
    olderDeferred.current = false;
    if (loaded && hasMoreBefore) void history.loadOlder(conversationId);
  };
  const { scroller, scrollerRef, scrollTopNow } = useScrollerBinding({
    rows,
    onScroll: () => {
      const el = scroller.current;
      if (!el) return;
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      measureSlack(el);
      pin.onScroll(distance, el.scrollTop);
      anchor.noteScroll(el, firstItemIndex);
      if (!pin.isHeldAway) {
        setReleasedEpoch(epoch);
        loadDeferredOlder();
      }
      setFarFromBottom(distance > el.clientHeight);
      measureEnd();
      scheduleMeasure();
    },
    onResize: () => {
      if (scroller.current) measureSlack(scroller.current);
      repin();
      measureEnd();
    },
    onReaderInput: () => {
      pin.onReaderInput();
      setReleasedEpoch(epoch);
      loadDeferredOlder();
    },
  });
  const { dividerIndex, dividerPos, scheduleMeasure, rangeChanged } = useUnreadDivider({
    items,
    scroller,
  });
  const { target, setTarget, clearTarget } = useJumpTarget({
    items,
    virtuoso,
    scroller,
    rows,
    reducedMotion,
  });

  useFollowOwnSend({ items, epoch, anchoredToPresent, pin, scrollTopNow, scrollToBottom });
  // Someone else's message never moves a reader who has scrolled up; the pill says it is there.
  const selfId = useStore(stores.session, sessionSelectors.selfId);
  const readerAtBottom = useCallback(() => pin.isStuck, [pin]);
  const { below: newBelow, clear: clearNewBelow } = useArrivalsBelow({
    items,
    epoch,
    anchoredToPresent,
    selfId: selfId ?? undefined,
    readerAtBottom,
    atBottom,
  });

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

  // Held where it opened, at the divider or a jump target: no older page until the reader moves the
  // list (C5, C8, C14). A page prepended while the virtualiser is still settling on its initial
  // index shifts the index it lands on by the page's length, so the target ends up off screen.
  // Read when the virtualiser reports, not at render: the reader can release the list in between.
  const holdsOlder = () => pin.isHeldAway && initialIndex.index !== 'LAST';

  // Each (re)mount decides once whether to hold the bottom — never on later renders.
  useLayoutEffect(() => {
    pin.reset(initialIndex.index === 'LAST');
  }, [pin, initialIndex]);

  // The divider sits before the first unread message that is loaded, so a page of older history can
  // move it relative to the rows (it is the first row of the loaded unread run, not a row of its own).
  // A list still held at the divider follows it; one the reader has moved, or that opened elsewhere, stays put.
  const dividerAbs = dividerIndex >= 0 ? firstItemIndex + dividerIndex : -1;
  const seenDivider = useRef({ epoch, abs: dividerAbs });
  useLayoutEffect(() => {
    const seen = seenDivider.current;
    seenDivider.current = { epoch, abs: dividerAbs };
    if (seen.epoch !== epoch || seen.abs < 0 || dividerAbs < 0 || seen.abs === dividerAbs) return;
    if (initialIndex.index === 'LAST' || !pin.isHeldAway) return;
    virtuoso.current?.scrollToIndex({
      index: dividerIndex,
      align: 'start',
      offset: TOP_OFFSET,
      behavior: 'auto',
    });
  });

  // A list held where it opened is not "at the bottom" for reading, however near its end it lies.
  const heldAway = initialIndex.index !== 'LAST' && releasedEpoch !== epoch;
  const atPresent = loaded && anchoredToPresent && atBottom && !heldAway;
  useReadTracking(conversationId, atPresent, atEnd);

  // The roving tab stop defaults to the newest message, and follows newer
  // ones until the user moves it, so leaving the composer lands on the
  // latest row. Never while that row has focus: the marker would leave it.
  // A message still sending is swapped for its sent version (same key, new
  // id) when the send completes: the tab stop moves to the new id, and focus
  // that was on the old row moves with it, so Esc right after Enter works.
  const newestId = useRef<MessageId | null>(null);
  const keysById = useRef<ReadonlyMap<MessageId, string>>(new Map());
  const orderedIds = useRef<readonly MessageId[]>([]);
  const focusedRowId = useRef<MessageId | null>(null);
  // Whether focus is in this list (a row, or the scroller's own tab stop). It survives the focused
  // element being removed, which is what lets a remount hand focus on to the new list.
  const listHasFocus = useRef(false);
  const restoring = useRef<{ frame: number } | null>(null);
  // Focus that has dropped to the page (its row was swapped, or the scroller was remounted) goes
  // to `find()` for a short while, counted from when it dropped: the new element is rendered and
  // settled a few frames later. Focus that is anywhere else is never taken.
  const restoreFocus = useCallback(
    (find: () => HTMLElement | null | undefined, goneRow?: MessageId) => {
      let frames = 0;
      const tick = () => {
        frames += 1;
        const here = document.activeElement;
        const target = find();
        // `goneRow`: a row removed from the data that the virtualiser has not taken off the page yet.
        const lost =
          !here ||
          here === document.body ||
          (goneRow !== undefined &&
            here.closest('[data-message-id]')?.getAttribute('data-message-id') === goneRow);
        if ((!lost && here !== target) || frames > RESTORE_FOCUS_FRAMES) {
          restoring.current = null;
          return;
        }
        if (lost && target) target.focus({ preventScroll: true });
        restoring.current = { frame: requestAnimationFrame(tick) };
      };
      if (restoring.current) cancelAnimationFrame(restoring.current.frame);
      restoring.current = { frame: requestAnimationFrame(tick) };
    },
    [],
  );
  useEffect(
    () => () => {
      if (restoring.current) cancelAnimationFrame(restoring.current.frame);
    },
    [],
  );
  // The virtualiser unmounts rows that scroll far out of range (PageUp, the wheel). When that
  // takes the focused row, focus drops to the page and the keys stop working: the scroller, the
  // list's own tab stop, takes it instead. Focus that went anywhere else on purpose is never taken
  // (see `restoreFocus`), nor a restoration already under way for a swapped or remounted row.
  useEffect(
    () =>
      rows.subscribe(() => {
        if (!listHasFocus.current || rows.activeMounted || restoring.current) return;
        restoreFocus(() => scroller.current);
      }),
    [rows, scroller, restoreFocus],
  );
  // The list remounts when its window is replaced (epoch): messages arriving in a chat that had
  // none, a jump outside the window, a reload. A focused scroller or row goes with it and focus
  // falls to the page: hand it to the new tab stop.
  const seenEpoch = useRef(epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch) return;
    seenEpoch.current = epoch;
    const here = document.activeElement;
    if (!listHasFocus.current || (here && here !== document.body)) return;
    restoreFocus(() => {
      const el = scroller.current;
      const active = rows.activeId;
      const row =
        active === null
          ? null
          : el?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(active)}"]`);
      return row ?? el;
    });
  }, [epoch, rows, scroller, restoreFocus]);
  useEffect(() => {
    const last = items.findLast((it) => it.type === 'message');
    const lastId = last && 'id' in last ? last.id : null;
    const previous = newestId.current;
    newestId.current = lastId;
    const previousKeys = keysById.current;
    const previousOrder = orderedIds.current;
    const messages = items.filter((it) => it.type === 'message');
    keysById.current = new Map(messages.map((it) => [it.id, it.key]));
    orderedIds.current = messages.map((it) => it.id);
    const active = rows.activeId;
    if (active !== null && !keysById.current.has(active)) {
      const key = previousKeys.get(active);
      const successor = key === undefined ? undefined : messages.find((it) => it.key === key);
      if (successor) {
        rows.setActive(successor.id);
        if (focusedRowId.current === active) {
          focusedRowId.current = successor.id;
          restoreFocus(() =>
            scroller.current?.querySelector<HTMLElement>(
              `[data-message-id="${CSS.escape(successor.id)}"]`,
            ),
          );
        }
        return;
      }
    }
    // The focused row itself went (deleted for me on another device, expired): focus goes to the
    // next message, else the previous one, else the list's own tab stop, never the page.
    const lost = focusedRowId.current;
    if (lost !== null && !keysById.current.has(lost)) {
      const heir = neighbourOf(previousOrder, orderedIds.current, lost);
      focusedRowId.current = heir ?? null;
      if (heir !== undefined) rows.setActive(heir);
      restoreFocus(() => {
        const row =
          heir === undefined
            ? null
            : scroller.current?.querySelector<HTMLElement>(
                `[data-message-id="${CSS.escape(heir)}"]`,
              );
        return row ?? scroller.current;
      }, lost);
      return;
    }
    if (active !== null && items.some((it) => 'id' in it && it.id === active)) {
      const following = active === previous && lastId !== null && lastId !== active;
      const focused = scroller.current
        ?.querySelector(`[data-message-id="${CSS.escape(active)}"]`)
        ?.contains(document.activeElement);
      if (!following || focused) return;
    }
    if (lastId !== null) rows.setActive(lastId);
  }, [items, rows, scroller, restoreFocus]);

  const jumpToPresent = useCallback(async () => {
    const w = stores.messages.getState().windows[conversationId];
    if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
    clearNewBelow();
    pin.beginFollow(scrollTopNow());
    requestAnimationFrame(scrollToBottom);
  }, [stores, history, conversationId, scrollToBottom, pin, scrollTopNow, clearNewBelow]);

  const reveal = useCallback(
    async (id: MessageId, options?: { flash?: boolean; focus?: boolean }) => {
      const next = { id, flash: options?.flash ?? true, focus: options?.focus ?? false };
      const w = stores.messages.getState().windows[conversationId];
      if (w && id in w.byId) {
        setTarget(next);
        return true;
      }
      // Set first, so the list remounting on the new window starts at the target.
      const token = setTarget(next);
      const ok = await history.jumpTo(conversationId, id);
      if (!ok) {
        // Only the latest request may clear the target.
        clearTarget(token);
        stores.ui.getState().pushToast({
          message: "The original message isn't available on this device.",
          kind: 'info',
          source: 'core',
        });
      }
      return ok;
    },
    [stores, history, conversationId, setTarget, clearTarget],
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
    [conversationId, navigation, scroller],
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
      // From the current message when it is rendered; else into the newest (↑) or first (↓) one.
      const at = all.findIndex((el) => el.dataset.messageId === rows.activeId);
      if (at >= 0) next = all[e.key === 'ArrowUp' ? at - 1 : at + 1];
      else next = e.key === 'ArrowUp' ? all.at(-1) : all[0];
    } else if (e.target.hasAttribute('data-roving-item')) {
      const i = all.indexOf(e.target);
      next = all[e.key === 'ArrowUp' ? i - 1 : i + 1];
    } else {
      return;
    }
    // ↑ on the oldest rendered message: scroll up, which loads older history.
    if (!next && e.key === 'ArrowUp') scroller.current?.scrollBy({ top: -200 });
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
        onFocus={(e) => {
          const row =
            e.target instanceof HTMLElement ? e.target.closest('[data-message-id]') : null;
          listHasFocus.current =
            e.target instanceof Node && scroller.current?.contains(e.target) === true;
          focusedRowId.current = (row?.getAttribute('data-message-id') as MessageId | null) ?? null;
        }}
        onBlur={(e) => {
          // A row that is taken out of the page while focused is not the user leaving it.
          if (e.target instanceof HTMLElement && e.target.isConnected) {
            focusedRowId.current = null;
            listHasFocus.current = false;
          }
        }}
        onPointerLeave={() => {
          rows.setHovered(null);
        }}
      >
        <NewMessagesBar
          conversationId={conversationId}
          dividerLoaded={dividerIndex >= 0}
          dividerAbove={dividerPos === 'above'}
          dividerVisible={dividerPos === 'visible'}
          onJumpToPresent={() => {
            void jumpToPresent();
          }}
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
          atBottomThreshold={slack}
          increaseViewportBy={{ top: 800, bottom: 400 }}
          defaultItemHeight={compact ? ROW_HEIGHT.compact : ROW_HEIGHT.comfortable}
          skipAnimationFrameInResizeObserver
          followOutput={() => {
            if (!pin.isStuck || !anchoredToPresent) return false;
            // The scrolling that follows is the list's own: it must not read as the reader leaving.
            pin.beginFollow(scrollTopNow());
            return reducedMotion() ? 'auto' : 'smooth';
          }}
          atBottomStateChange={(bottom) => {
            if (bottom) pin.onReachedBottom();
            else pin.onLeftBottom();
            setAtBottom(bottom);
            measureEnd();
          }}
          totalListHeightChanged={() => {
            repin();
            holdReader();
            measureEnd();
          }}
          rangeChanged={(range) => {
            rangeChanged(range.startIndex - firstItemIndex);
            if (!loaded) return;
            const decision = prefetchEdges(range, firstItemIndex, items.length, {
              hasMoreBefore,
              anchoredToPresent,
              holdOlder: holdsOlder(),
            });
            if (decision.deferOlder) olderDeferred.current = true;
            if (decision.loadOlder) void history.loadOlder(conversationId);
            if (decision.loadNewer) void history.loadNewer(conversationId);
          }}
          // Backstops rangeChanged's prefetch for a fling fast enough to skip
          // straight past the threshold in one jump (both are coalescing, so
          // calling both here costs nothing extra).
          startReached={() => {
            if (holdsOlder()) olderDeferred.current = true;
            else if (loaded && hasMoreBefore) void history.loadOlder(conversationId);
          }}
          endReached={() => {
            if (loaded && !anchoredToPresent) void history.loadNewer(conversationId);
          }}
          scrollerRef={scrollerRef}
          components={COMPONENTS}
          itemContent={(_, item, ctx) => <Row item={item} context={ctx} />}
        />
        <JumpToPresent
          visible={loaded && (!anchoredToPresent || farFromBottom || newBelow)}
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
