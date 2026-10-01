import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
} from 'react';
import { Virtuoso, type Components, type VirtuosoHandle } from 'react-virtuoso';
import { useStore } from 'zustand';
import type { ConversationId, ConversationView, MessageId, RenderItem } from '@/core/domain';
import { conversationsSelectors } from '@/core/stores';
import { useHearth } from '@/ui/hooks';
import { useChatController } from '../ChatController';
import { MessageItem } from '../message/MessageItem';
import { ConversationIntro } from './ConversationIntro';
import { DayDivider } from './DayDivider';
import { HistorySkeleton } from './HistorySkeleton';
import { JumpToPresent } from './JumpToPresent';
import { NewDivider } from './NewDivider';
import { NewMessagesBar } from './NewMessagesBar';
import { SystemRow } from './SystemRow';
import { useListItems } from './useListItems';
import { RowState, RowStateProvider } from './rowState';
import { useReadTracking } from './useReadTracking';
import styles from './MessageList.module.css';

interface ListContext {
  conversation: ConversationView;
  compact: boolean;
  compactAvatars: boolean;
  loadingOlder: boolean;
  hasMoreBefore: boolean;
  loaded: boolean;
}

/** Items within this many rows of the end open at the bottom instead of at the divider. */
const DIVIDER_NEAR_END = 12;
const FLASH_MS = 1600;

function reducedMotion(): boolean {
  const attr = document.documentElement.dataset.reducedMotion;
  if (attr === 'on') return true;
  if (attr === 'off') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const ListEl = forwardRef<
  HTMLDivElement,
  HTMLAttributes<HTMLDivElement> & { context?: ListContext }
>(function ListEl({ context, children, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      role="log"
      aria-live="polite"
      aria-relevant="additions"
      aria-label={context ? `Messages in ${context.conversation.title}` : 'Messages'}
      data-hearth="message-log"
    >
      {children}
    </div>
  );
});

const COMPONENTS: Components<RenderItem, ListContext> = {
  List: ListEl,
  Header: ({ context }) =>
    context.loaded && !context.hasMoreBefore ? (
      <ConversationIntro conversation={context.conversation} />
    ) : (
      <HistorySkeleton rows={context.loaded ? 3 : 8} />
    ),
  Footer: () => <div className={styles.footer} />,
};

/**
 * The virtualised, bottom-anchored message list. Older history prepends
 * without moving the view (firstItemIndex bookkeeping in useListItems);
 * jumps to old messages replace the window and remount at the target.
 */
export function MessageList({ conversation }: { conversation: ConversationView }) {
  const app = useHearth();
  const { stores, history } = app;
  const chat = useChatController();
  const conversationId: ConversationId = conversation.id;
  const model = useListItems(conversationId);
  const { items, firstItemIndex, epoch, loaded, loading, hasMoreBefore, anchoredToPresent } = model;
  const compact = useStore(stores.settings, (s) => s.appearance.density === 'compact');
  const compactAvatars = useStore(stores.settings, (s) => s.appearance.showAvatarsInCompact);
  const unread = useStore(stores.conversations, conversationsSelectors.unread(conversationId));
  const virtuoso = useRef<VirtuosoHandle>(null);
  const scroller = useRef<HTMLElement | null>(null);
  /**
   * Whether to hold the view at the bottom while row heights settle (images,
   * fonts, first measurement). True at the bottom, and after opening at the
   * bottom until the user scrolls themselves.
   */
  const stick = useRef(false);
  // Starts false: a list opened at the unread divider must not count as "seen to the bottom".
  const [atBottom, setAtBottom] = useState(false);
  const [bottomEpoch, setBottomEpoch] = useState(epoch);
  if (bottomEpoch !== epoch) {
    // A remounted virtualiser reports its own bottom state afresh.
    setBottomEpoch(epoch);
    setAtBottom(false);
  }
  const [farFromBottom, setFarFromBottom] = useState(false);
  const [target, setTarget] = useState<{ id: MessageId; flash: boolean } | null>(null);
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
      return { index: dividerIndex, align: 'start' as const, offset: -48 };
    return { index: 'LAST' as const, align: 'end' as const };
    // Only consulted when the list remounts (epoch); later item changes must not move the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch]);

  // A pending jump whose target is now loaded: scroll to it and flash it.
  useEffect(() => {
    if (!target) return;
    const index = indexOf(target.id);
    if (index < 0) return;
    const { id, flash } = target;
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
      setTarget(null);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, indexOf, rows]);

  const scrollToBottom = useCallback(() => {
    virtuoso.current?.scrollToIndex({ index: 'LAST', align: 'end', behavior: 'auto' });
  }, []);

  const jumpToPresent = useCallback(async () => {
    const w = stores.messages.getState().windows[conversationId];
    if (w && !w.anchoredToPresent) await history.jumpToPresent(conversationId);
    requestAnimationFrame(scrollToBottom);
  }, [stores, history, conversationId, scrollToBottom]);

  const reveal = useCallback(
    async (id: MessageId, options?: { flash?: boolean }) => {
      const flash = options?.flash ?? true;
      const w = stores.messages.getState().windows[conversationId];
      if (w && id in w.byId) {
        setTarget({ id, flash });
        return true;
      }
      // Set first, so the list remounting on the new window starts at the target.
      setTarget({ id, flash });
      const ok = await history.jumpTo(conversationId, id);
      if (!ok) setTarget(null);
      if (!ok)
        stores.ui.getState().pushToast({
          message: "The original message isn't available on this device.",
          kind: 'info',
          source: 'core',
        });
      return ok;
    },
    [stores, history, conversationId],
  );

  useEffect(
    () => chat.registerList({ conversationId, jumpToPresent, reveal }),
    [chat, conversationId, jumpToPresent, reveal],
  );

  const measureRef = useRef<() => void>(() => undefined);
  const firstRendered = useRef(0);
  const measureDivider = () => {
    const el = scroller.current;
    const divider = el?.querySelector('[data-hearth="new-divider"]');
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
  useEffect(() => {
    measureRef.current = measureDivider;
  });

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Scrolled away from the bottom (by the user or a jump): stop holding it there.
    if (distance > 64) stick.current = false;
    setFarFromBottom(distance > el.clientHeight);
    measureRef.current();
  }, []);

  const context: ListContext = {
    conversation,
    compact,
    compactAvatars,
    loadingOlder: loading && loaded,
    hasMoreBefore,
    loaded,
  };

  /** ↑/↓ move between messages; from the scroller itself they step into the newest visible one. */
  const onRowKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (!(e.target instanceof HTMLElement)) return;
    const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('[data-roving-item]')];
    if (e.target === scroller.current) {
      const row = e.key === 'ArrowUp' ? rows.at(-1) : rows[0];
      if (row) {
        e.preventDefault();
        row.focus();
      }
      return;
    }
    if (!e.target.hasAttribute('data-roving-item')) return;
    const i = rows.indexOf(e.target);
    const next = rows[e.key === 'ArrowUp' ? i - 1 : i + 1];
    e.preventDefault();
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      scroller.current?.scrollBy({ top: -200 });
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
          defaultItemHeight={48}
          followOutput={(bottom) =>
            bottom && anchoredToPresent ? (reducedMotion() ? 'auto' : 'smooth') : false
          }
          atBottomStateChange={(bottom) => {
            if (bottom) stick.current = true;
            setAtBottom(bottom);
          }}
          totalListHeightChanged={() => {
            if (stick.current && anchoredToPresent) scrollToBottom();
          }}
          rangeChanged={(range) => {
            firstRendered.current = range.startIndex - firstItemIndex;
            measureDivider();
          }}
          startReached={() => {
            if (loaded && hasMoreBefore) void history.loadOlder(conversationId);
          }}
          endReached={() => {
            if (loaded && !anchoredToPresent) void history.loadNewer(conversationId);
          }}
          scrollerRef={(el) => {
            const node = el instanceof HTMLElement ? el : null;
            if (scroller.current === node) return;
            scroller.current?.removeEventListener('scroll', onScroll);
            scroller.current = node;
            if (node) {
              stick.current = initialIndex.index === 'LAST';
              node.tabIndex = 0;
              node.setAttribute('aria-label', `${conversation.title} messages`);
              node.addEventListener('scroll', onScroll, { passive: true });
            }
          }}
          components={COMPONENTS}
          itemContent={(_, item, ctx) => <Row item={item} context={ctx} />}
        />
        <JumpToPresent
          visible={loaded && (!anchoredToPresent || farFromBottom)}
          count={atPresent ? 0 : unread.count}
          onJump={() => {
            void jumpToPresent();
          }}
        />
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
    if (id) setTarget({ id, flash: false });
  }
}

function Row({ item, context }: { item: RenderItem; context: ListContext }) {
  switch (item.type) {
    case 'day-divider':
      return <DayDivider at={item.at} />;
    case 'new-divider':
      return <NewDivider />;
    case 'system':
      return <SystemRow conversationId={context.conversation.id} id={item.id} />;
    case 'message':
      return (
        <div
          className={styles.item}
          data-group-start={item.continuation ? undefined : ''}
          data-compact={context.compact ? '' : undefined}
        >
          <MessageItem
            conversationId={context.conversation.id}
            id={item.id}
            continuation={item.continuation}
            compact={context.compact}
            compactAvatars={context.compactAvatars}
          />
        </div>
      );
  }
}
