import { Clock, Sticker as StickerIcon } from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react';
import { useStore } from 'zustand';
import type { StickerPackInfo } from '@/core/backend';
import type { ConversationId, StickerContent } from '@/core/domain';
import { useSnowdrop } from '@/ui/hooks';
import { Button, EmptyState, Popover, Skeleton } from '@/ui/primitives';
import { useStickerUrl } from '../message/useStickerUrl';
import { useStickerPacks } from './useStickerPacks';
import styles from './StickerPicker.module.css';

/** Columns of the sticker grid (also the Up/Down step of keyboard navigation). */
const COLUMNS = 4;
const RECENT = 'recent';

interface Cell {
  packId: string;
  stickerId: number;
  emoji: string;
  url?: string;
}

const cellKey = (c: { packId: string; stickerId: number }) => `${c.packId}:${c.stickerId}`;

export interface StickerPickerProps {
  conversationId: ConversationId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Sends the sticker straight away; the picker closes itself. */
  onPick: (sticker: StickerContent) => void;
  /** Called when the picker has closed, to put focus back in the composer. */
  onCloseFocus: () => void;
  /** The button that opens the picker (a button that forwards refs). */
  children: ReactElement;
}

/** The sticker picker in a popover, anchored to (and toggled by) its child. */
export function StickerPicker({
  conversationId,
  open,
  onOpenChange,
  onPick,
  onCloseFocus,
  children,
}: StickerPickerProps) {
  return (
    <Popover
      trigger={children}
      open={open}
      onOpenChange={onOpenChange}
      label="Sticker picker"
      side="top"
      align="end"
      flush
      className={styles.popover}
      onCloseAutoFocus={(e) => {
        e.preventDefault();
        onCloseFocus();
      }}
    >
      {open && (
        <StickerPanel
          conversationId={conversationId}
          onPick={(sticker) => {
            onOpenChange(false);
            onPick(sticker);
          }}
        />
      )}
    </Popover>
  );
}

function StickerPanel({
  conversationId,
  onPick,
}: {
  conversationId: ConversationId;
  onPick: (sticker: StickerContent) => void;
}) {
  const { stores } = useSnowdrop();
  const packsState = useStickerPacks(true);
  const recentIds = useStore(stores.local, (s) => s.recentStickers);
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const cells = useRef(new Map<number, HTMLButtonElement>());
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const [chosen, setChosen] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [preview, setPreview] = useState('');

  const packs = useMemo(
    (): readonly StickerPackInfo[] => (packsState.status === 'ready' ? packsState.packs : []),
    [packsState],
  );
  const recent = useMemo((): Cell[] => {
    const known = new Map<string, Cell>();
    for (const pack of packs)
      for (const s of pack.stickers)
        known.set(cellKey({ packId: pack.packId, stickerId: s.stickerId }), {
          packId: pack.packId,
          stickerId: s.stickerId,
          emoji: s.emoji,
          ...(s.url !== undefined ? { url: s.url } : {}),
        });
    return recentIds.flatMap((r) => known.get(cellKey(r)) ?? []);
  }, [packs, recentIds]);

  // Recent first when there is something in it, else the first pack.
  const tab =
    chosen !== null && (chosen === RECENT || packs.some((p) => p.packId === chosen))
      ? chosen
      : recent.length > 0
        ? RECENT
        : (packs[0]?.packId ?? RECENT);
  const pack = tab === RECENT ? undefined : packs.find((p) => p.packId === tab);
  const items: Cell[] = pack
    ? pack.stickers.map((s) => ({
        packId: pack.packId,
        stickerId: s.stickerId,
        emoji: s.emoji,
        ...(s.url !== undefined ? { url: s.url } : {}),
      }))
    : recent;
  const title = pack ? pack.title || 'Sticker pack' : 'Recent';
  const ready = packsState.status === 'ready' && packs.length > 0;
  const cursor = Math.min(active, Math.max(0, items.length - 1));

  const selectTab = (id: string, focus = false) => {
    setChosen(id);
    setActive(0);
    setPreview('');
    if (focus) requestAnimationFrame(() => tabs.current.get(id)?.focus());
  };

  // Focus lands on the grid once it exists (packs load after the popover opens).
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (!ready || focusedOnce.current) return;
    const surface = root.current?.parentElement;
    const focused = document.activeElement;
    if (focused && focused !== surface && root.current?.contains(focused)) return;
    focusedOnce.current = true;
    cells.current.get(cursor)?.focus();
  }, [ready, cursor]);

  const focusCell = (index: number) => {
    const next = Math.max(0, Math.min(items.length - 1, index));
    setActive(next);
    requestAnimationFrame(() => cells.current.get(next)?.focus());
  };

  const tabIds = [RECENT, ...packs.map((p) => p.packId)];
  const onGridKeyDown = (e: KeyboardEvent) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const steps: Record<string, number> = {
      ArrowRight: 1,
      ArrowLeft: -1,
      ArrowDown: COLUMNS,
      ArrowUp: -COLUMNS,
    };
    const step = steps[e.key];
    if (step !== undefined) {
      e.preventDefault();
      const target = cursor + step;
      // Up from the first row / down from the last row stays put.
      if (target >= 0 && target < items.length) focusCell(target);
      else if (Math.abs(step) === COLUMNS && step > 0 && cursor < items.length - 1)
        focusCell(items.length - 1);
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      focusCell(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusCell(items.length - 1);
    } else if (e.key === 'PageDown' || e.key === 'PageUp') {
      e.preventDefault();
      const at = tabIds.indexOf(tab);
      const next = tabIds[at + (e.key === 'PageDown' ? 1 : -1)];
      if (next !== undefined) selectTab(next);
    }
  };

  const onTabKeyDown = (e: KeyboardEvent) => {
    const at = tabIds.indexOf(tab);
    let next: string | undefined;
    if (e.key === 'ArrowRight') next = tabIds[at + 1];
    else if (e.key === 'ArrowLeft') next = tabIds[at - 1];
    else if (e.key === 'Home') next = tabIds[0];
    else if (e.key === 'End') next = tabIds[tabIds.length - 1];
    else return;
    e.preventDefault();
    if (next !== undefined) selectTab(next, true);
  };

  return (
    <div className={styles.root} data-snowdrop="sticker-picker" ref={root}>
      {packsState.status === 'loading' && (
        <div className={styles.body} aria-busy="true">
          <p className={styles.status} role="status">
            Loading stickers…
          </p>
          <div className={styles.grid} aria-hidden>
            {Array.from({ length: 12 }, (_, i) => (
              <span className={styles.cell} key={i} data-loading="">
                <Skeleton width="72%" height="72%" radius="sm" />
              </span>
            ))}
          </div>
        </div>
      )}
      {packsState.status === 'error' && (
        <EmptyState
          size="sm"
          className={styles.empty}
          icon={<StickerIcon />}
          title="Couldn’t load your stickers"
          action={
            <Button size="sm" onClick={packsState.retry}>
              Try again
            </Button>
          }
        >
          Check that Snowdrop is connected.
        </EmptyState>
      )}
      {packsState.status === 'ready' && packs.length === 0 && (
        <EmptyState
          size="sm"
          className={styles.empty}
          icon={<StickerIcon />}
          title="No sticker packs"
        >
          Install sticker packs on your phone and they will show up here.
        </EmptyState>
      )}
      {ready && (
        <>
          <div className={styles.header}>
            <h2 className={styles.title}>{title}</h2>
            {pack?.author && <span className={styles.author}>{pack.author}</span>}
            <span className={styles.preview} aria-hidden data-sticker-preview="">
              {preview}
            </span>
          </div>
          <div
            className={styles.viewport}
            ref={setScroller}
            role="tabpanel"
            id={panelId}
            aria-label={title}
          >
            {items.length === 0 ? (
              <p className={styles.status}>Stickers you send appear here.</p>
            ) : (
              <div className={styles.grid} onKeyDown={onGridKeyDown}>
                {items.map((cell, i) => (
                  <button
                    key={cellKey(cell)}
                    type="button"
                    ref={(el) => {
                      if (el) cells.current.set(i, el);
                      else cells.current.delete(i);
                    }}
                    className={styles.cell}
                    tabIndex={i === cursor ? 0 : -1}
                    aria-label={cell.emoji ? `${cell.emoji} sticker` : 'Sticker'}
                    data-snowdrop="sticker-cell"
                    onMouseEnter={() => {
                      setPreview(cell.emoji);
                    }}
                    onMouseLeave={() => {
                      setPreview('');
                    }}
                    onFocus={() => {
                      setActive(i);
                      setPreview(cell.emoji);
                    }}
                    onBlur={() => {
                      setPreview('');
                    }}
                    onClick={() => {
                      onPick({
                        packId: cell.packId,
                        stickerId: cell.stickerId,
                        ...(cell.emoji ? { emoji: cell.emoji } : {}),
                        ...(cell.url !== undefined ? { url: cell.url } : {}),
                      });
                    }}
                  >
                    <StickerThumb
                      conversationId={conversationId}
                      sticker={cell}
                      root={scroller}
                      lazy
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
          <div
            className={styles.tabs}
            role="tablist"
            aria-label="Sticker packs"
            onKeyDown={onTabKeyDown}
          >
            <button
              type="button"
              role="tab"
              ref={(el) => {
                if (el) tabs.current.set(RECENT, el);
                else tabs.current.delete(RECENT);
              }}
              className={styles.tab}
              aria-selected={tab === RECENT}
              aria-controls={panelId}
              aria-label="Recent"
              title="Recent"
              tabIndex={tab === RECENT ? 0 : -1}
              onClick={() => {
                selectTab(RECENT);
              }}
            >
              <Clock aria-hidden />
            </button>
            {packs.map((p) => (
              <button
                key={p.packId}
                type="button"
                role="tab"
                ref={(el) => {
                  if (el) tabs.current.set(p.packId, el);
                  else tabs.current.delete(p.packId);
                }}
                className={styles.tab}
                aria-selected={tab === p.packId}
                aria-controls={panelId}
                aria-label={p.title || 'Sticker pack'}
                title={p.title || 'Sticker pack'}
                tabIndex={tab === p.packId ? 0 : -1}
                onClick={() => {
                  selectTab(p.packId);
                }}
              >
                <StickerThumb
                  conversationId={conversationId}
                  sticker={{ packId: p.packId, ...p.cover }}
                  root={null}
                />
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** True once `el` has come near the viewport of `root`; stays true after (the image stays loaded). */
function useNearViewport(
  el: HTMLElement | null,
  root: HTMLElement | null,
  enabled: boolean,
): boolean {
  const [near, setNear] = useState(() => !enabled || typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (near || !el || (enabled && !root)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { root, rootMargin: '96px' },
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, [el, root, near, enabled]);
  return near;
}

/**
 * A sticker image in a fixed-size box: the placeholder never changes size, so
 * nothing jumps when the image arrives. `lazy` cells only start fetching once
 * scrolled near view.
 */
function StickerThumb({
  conversationId,
  sticker,
  root,
  lazy = false,
}: {
  conversationId: ConversationId;
  sticker: { packId: string; stickerId: number; emoji?: string; url?: string };
  root: HTMLElement | null;
  lazy?: boolean;
}) {
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  const near = useNearViewport(el, root, lazy);
  return (
    <span className={styles.thumb} ref={setEl}>
      {near ? (
        <ThumbImage conversationId={conversationId} sticker={sticker} />
      ) : (
        <StickerIcon className={styles.placeholder} aria-hidden />
      )}
    </span>
  );
}

function ThumbImage({
  conversationId,
  sticker,
}: {
  conversationId: ConversationId;
  sticker: { packId: string; stickerId: number; emoji?: string; url?: string };
}) {
  const [failed, setFailed] = useState(false);
  const state = useStickerUrl(conversationId, {
    packId: sticker.packId,
    stickerId: sticker.stickerId,
    ...(sticker.url !== undefined ? { url: sticker.url } : {}),
  });
  if (state.status === 'ready' && !failed)
    return (
      <img
        className={styles.image}
        src={state.url}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => {
          setFailed(true);
        }}
      />
    );
  if (state.status === 'loading' && !failed)
    return <StickerIcon className={styles.placeholder} aria-hidden />;
  return sticker.emoji ? (
    <span className={styles.fallback} aria-hidden>
      {sticker.emoji}
    </span>
  ) : (
    <StickerIcon className={styles.placeholder} aria-hidden />
  );
}
