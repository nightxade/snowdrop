import { Download, ImageOff, Loader2, MessageSquare, Play, RotateCw, Video } from 'lucide-react';
import { useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import type { MessageRef } from '@/core/backend';
import type { ConversationId, GalleryItem, GallerySection } from '@/core/domain';
import { ContextMenu, IconButton, type MenuEntry } from '@/ui/primitives';
import { attachmentFailureCopy, attachmentKind } from '../lib/attachments';
import { useAttachmentUrl } from '../message/useAttachmentUrl';
import type { ItemMeta } from './useItemMeta';
import { useNearView } from './useNearView';
import styles from './MediaGrid.module.css';

type AttachmentItem = Extract<GalleryItem, { type: 'attachment' }>;

export interface MediaGridProps {
  conversationId: ConversationId;
  sections: readonly GallerySection[];
  describe: (item: AttachmentItem) => ItemMeta;
  onOpen: (item: AttachmentItem) => void;
  onJump: (item: AttachmentItem) => void;
}

/** What a tile's click does, which depends on what its bytes are doing. */
interface TileAction {
  label: string;
  run: () => void;
}

const TILE = '[data-gallery-tile]';

/**
 * Thumbnails grouped by date, one tab stop for the whole grid: arrows move
 * between tiles (up and down by what is drawn above or below, not by a
 * column count), Home and End jump to the ends, Enter opens.
 */
export function MediaGrid({ conversationId, sections, describe, onOpen, onJump }: MediaGridProps) {
  const [active, setActive] = useState<string | null>(null);
  const firstKey = sections[0]?.items[0]?.key;
  const known = sections.some((s) => s.items.some((i) => i.key === active));
  const tabStop = known ? active : (firstKey ?? null);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const tiles = [...event.currentTarget.querySelectorAll<HTMLElement>(TILE)];
    const from = tiles.findIndex((el) => el === document.activeElement);
    if (from === -1) return;
    event.preventDefault();
    let to: number;
    if (event.key === 'ArrowLeft') to = from - 1;
    else if (event.key === 'ArrowRight') to = from + 1;
    else if (event.key === 'Home') to = 0;
    else if (event.key === 'End') to = tiles.length - 1;
    else to = verticalNeighbour(tiles, from, event.key === 'ArrowDown' ? 1 : -1);
    const target = tiles[Math.max(0, Math.min(tiles.length - 1, to))];
    target?.focus();
    target?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className={styles.sections} onKeyDown={onKeyDown}>
      {sections.map((section) => (
        <section key={section.key} className={styles.section} aria-labelledby={`g-${section.key}`}>
          <h3 id={`g-${section.key}`} className={styles.heading}>
            {section.label}
          </h3>
          <ul className={styles.grid}>
            {section.items.map((item) =>
              item.type === 'attachment' ? (
                <Tile
                  key={item.key}
                  conversationId={conversationId}
                  item={item}
                  meta={describe(item)}
                  tabStop={item.key === tabStop}
                  onFocusTile={() => {
                    setActive(item.key);
                  }}
                  onOpen={onOpen}
                  onJump={onJump}
                />
              ) : null,
            )}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The tile above or below `from`: the next row in that direction, nearest by centre. */
function verticalNeighbour(tiles: readonly HTMLElement[], from: number, dir: 1 | -1): number {
  const here = tiles[from]?.getBoundingClientRect();
  if (!here) return from;
  const centre = here.left + here.width / 2;
  let rowTop: number | undefined;
  let best = from;
  let bestDistance = Infinity;
  const order = dir === 1 ? tiles.slice(from + 1) : tiles.slice(0, from).reverse();
  for (const el of order) {
    const rect = el.getBoundingClientRect();
    const beyond = dir === 1 ? rect.top > here.top + 1 : rect.top < here.top - 1;
    if (!beyond) continue;
    // Only the first row met in that direction counts.
    rowTop ??= rect.top;
    if (Math.abs(rect.top - rowTop) > 1) break;
    const distance = Math.abs(rect.left + rect.width / 2 - centre);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = tiles.indexOf(el);
    }
  }
  return best;
}

function Tile({
  conversationId,
  item,
  meta,
  tabStop,
  onFocusTile,
  onOpen,
  onJump,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  meta: ItemMeta;
  tabStop: boolean;
  onFocusTile: () => void;
  onOpen: (item: AttachmentItem) => void;
  onJump: (item: AttachmentItem) => void;
}) {
  const [ref, near] = useNearView<HTMLLIElement>();
  // What the live body (only mounted near the viewport) says a click should do.
  const [action, setAction] = useState<TileAction | null>(null);
  const video = attachmentKind(item.attachment) === 'video';
  const noun = item.attachment.fileName ?? (video ? 'video' : 'photo');
  const open = useCallback(() => {
    onOpen(item);
  }, [onOpen, item]);
  const run = action ?? { label: `Open ${noun}`, run: open };
  const entries = (): MenuEntry[] => [
    { kind: 'item', id: 'act', label: run.label, onSelect: run.run },
    {
      kind: 'item',
      id: 'jump',
      label: 'Go to message',
      icon: <MessageSquare size={14} />,
      onSelect: () => {
        onJump(item);
      },
    },
  ];
  return (
    <li ref={ref} className={styles.cell}>
      <ContextMenu entries={entries} label="Media options">
        <button
          type="button"
          className={styles.tile}
          data-gallery-tile
          tabIndex={tabStop ? 0 : -1}
          aria-label={`${run.label}, from ${meta.author}, ${meta.when}`}
          onFocus={onFocusTile}
          onClick={run.run}
        >
          {near ? (
            <TileBody
              conversationId={conversationId}
              item={item}
              video={video}
              onAction={setAction}
              noun={noun}
              open={open}
            />
          ) : (
            <span className={styles.idle} aria-hidden>
              {video ? <Video size={20} /> : null}
            </span>
          )}
        </button>
      </ContextMenu>
      <IconButton
        label="Go to message"
        icon={<MessageSquare />}
        size="sm"
        tabIndex={-1}
        className={styles.jump}
        tooltipSide="bottom"
        onClick={() => {
          onJump(item);
        }}
      />
    </li>
  );
}

/**
 * The thumbnail itself. Mounted only while the tile is near the viewport,
 * so this is the only place a gallery fetches anything: scrolling past a
 * tile never downloads it, and a message request's media stays held until
 * its owner asks (useAttachmentUrl).
 */
function TileBody({
  conversationId,
  item,
  video,
  noun,
  open,
  onAction,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  video: boolean;
  noun: string;
  open: () => void;
  onAction: (action: TileAction | null) => void;
}) {
  const { message, attachment } = item;
  const ref: MessageRef = { authorId: message.authorId, sentAt: message.sentAt };
  const state = useAttachmentUrl(
    conversationId,
    ref,
    attachment,
    message.attachments.map((a) => a.id),
  );
  const { status, retry, download } = state;
  const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
  const retryable = failure?.retryable === true;

  useEffect(() => {
    if (status === 'held') onAction({ label: `Download ${noun}`, run: download });
    else if (retryable) onAction({ label: `Retry ${noun}`, run: retry });
    else onAction({ label: `Open ${noun}`, run: open });
    return () => {
      onAction(null);
    };
  }, [status, retryable, noun, download, retry, open, onAction]);

  if (status === 'ready') {
    return video ? (
      <>
        <video
          className={styles.media}
          src={state.url}
          preload="metadata"
          muted
          playsInline
          tabIndex={-1}
          onError={state.onMediaError}
        />
        <span className={styles.play} aria-hidden>
          <Play size={16} fill="currentColor" />
        </span>
      </>
    ) : (
      <img
        className={styles.media}
        src={state.url}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        onError={state.onMediaError}
      />
    );
  }
  if (status === 'held')
    return (
      <span className={styles.status}>
        <Download size={18} aria-hidden />
        <span>Download</span>
      </span>
    );
  if (status === 'error')
    return (
      <span className={styles.status} title={failure?.detail}>
        {retryable ? <RotateCw size={18} aria-hidden /> : <ImageOff size={18} aria-hidden />}
        <span>{retryable ? 'Retry' : (failure?.label ?? 'Not available')}</span>
      </span>
    );
  if (status === 'unavailable')
    return (
      <span className={styles.status}>
        <ImageOff size={18} aria-hidden />
        <span>Not available</span>
      </span>
    );
  return (
    <span className={styles.status} data-busy="">
      {status === 'backfilling' ? <Loader2 size={18} className={styles.spin} aria-hidden /> : null}
      {status === 'backfilling' ? <span>From your phone…</span> : null}
    </span>
  );
}
