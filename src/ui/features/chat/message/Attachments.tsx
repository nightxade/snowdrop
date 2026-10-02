import { Download, FileText, ImageOff, Play, RotateCw } from 'lucide-react';
import { memo, useState, type CSSProperties } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { Lightbox, Tooltip, type LightboxItem } from '@/ui/primitives';
import { attachmentKind, fitMedia, formatBytes, isGridMedia, safeHref } from '../lib/attachments';
import { useAttachmentUrl } from './useAttachmentUrl';
import styles from './Attachments.module.css';

export interface AttachmentsProps {
  conversationId: ConversationId;
  attachments: readonly Attachment[];
  /** Upload in progress (optimistic message). */
  pending: boolean;
  caption?: string;
}

const GRID_MAX = 4;

export const Attachments = memo(function Attachments({
  conversationId,
  attachments,
  pending,
  caption,
}: AttachmentsProps) {
  const media = attachments.filter((a) => isGridMedia(a));
  const others = attachments.filter((a) => !isGridMedia(a));
  const [viewer, setViewer] = useState<number | null>(null);
  const [urls, setUrls] = useState<Record<string, string>>({});

  const items: LightboxItem[] = media.flatMap((a) => {
    const src = a.url ?? urls[a.id];
    if (!src) return [];
    return [
      {
        src,
        kind: attachmentKind(a) === 'video' ? ('video' as const) : ('image' as const),
        alt: a.fileName ?? 'Attachment',
        fileName: a.fileName,
        downloadHref: safeHref(src),
        width: a.width,
        height: a.height,
      },
    ];
  });
  const open = (a: Attachment, url: string) => {
    if (!a.url) setUrls((u) => (u[a.id] === url ? u : { ...u, [a.id]: url }));
    // Position among the media the viewer can show (those with a URL, now including this one).
    const index = media
      .filter((m) => m.id === a.id || m.url !== undefined || urls[m.id] !== undefined)
      .indexOf(a);
    setViewer(Math.max(0, index));
  };

  const shown = media.slice(0, GRID_MAX);
  const overflow = media.length - shown.length;

  return (
    <div className={styles.attachments}>
      {shown.length > 0 && (
        <div
          className={styles.grid}
          data-count={shown.length}
          style={shown.length === 1 ? singleStyle(shown[0] as Attachment) : undefined}
        >
          {shown.map((a, i) => (
            <MediaTile
              key={a.id}
              conversationId={conversationId}
              attachment={a}
              pending={pending}
              more={i === shown.length - 1 && overflow > 0 ? overflow : 0}
              onOpen={open}
            />
          ))}
        </div>
      )}
      {others.map((a) =>
        attachmentKind(a) === 'audio' ? (
          <AudioCard key={a.id} conversationId={conversationId} attachment={a} pending={pending} />
        ) : (
          <FileCard key={a.id} conversationId={conversationId} attachment={a} pending={pending} />
        ),
      )}
      {items.length > 0 && (
        // Stays mounted: unmounting an open Radix dialog can leave the page inert.
        <Lightbox
          items={items}
          index={Math.min(viewer ?? 0, items.length - 1)}
          onIndexChange={setViewer}
          open={viewer !== null}
          onOpenChange={(o) => {
            if (!o) setViewer(null);
          }}
          caption={caption}
        />
      )}
    </div>
  );
});

function singleStyle(a: Attachment): CSSProperties {
  const box = fitMedia(a);
  return { width: box.width, aspectRatio: `${box.width} / ${box.height}` };
}

interface TileProps {
  conversationId: ConversationId;
  attachment: Attachment;
  pending: boolean;
  more: number;
  onOpen: (a: Attachment, url: string) => void;
}

function MediaTile({ conversationId, attachment, pending, more, onOpen }: TileProps) {
  const state = useAttachmentUrl(conversationId, attachment);
  const [broken, setBroken] = useState(false);
  const video = attachmentKind(attachment) === 'video';
  const name = attachment.fileName ?? (video ? 'Video' : 'Image');

  if (state.status !== 'ready' || broken) {
    const failed =
      state.status === 'error' || broken || (state.status === 'unavailable' && !pending);
    return (
      <div className={styles.tile} data-state={failed ? 'error' : 'loading'} aria-label={name}>
        {failed ? (
          <span className={styles.tileError}>
            <ImageOff size={20} aria-hidden />
            <span>{state.status === 'unavailable' ? 'Not available' : "Couldn't load"}</span>
            {state.status === 'error' && (
              <button type="button" className={styles.retry} onClick={state.retry}>
                <RotateCw size={12} aria-hidden /> Retry
              </button>
            )}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={styles.tile}
      data-open-attachment
      aria-label={`Open ${name}${more > 0 ? `, and ${more} more` : ''}`}
      onClick={() => {
        onOpen(attachment, state.url);
      }}
    >
      {video ? (
        <>
          <video className={styles.media} src={state.url} preload="metadata" muted playsInline />
          <span className={styles.play} aria-hidden>
            <Play size={20} fill="currentColor" />
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
          onError={() => {
            setBroken(true);
          }}
        />
      )}
      {more > 0 && <span className={styles.more}>+{more}</span>}
    </button>
  );
}

interface CardProps {
  conversationId: ConversationId;
  attachment: Attachment;
  pending: boolean;
}

function DownloadButton({ url, fileName }: { url: string; fileName: string | undefined }) {
  const href = safeHref(url);
  if (!href) return null;
  return (
    <Tooltip label="Download">
      <a className={styles.download} href={href} download={fileName ?? true} aria-label="Download">
        <Download size={18} aria-hidden />
      </a>
    </Tooltip>
  );
}

function FileCard({ conversationId, attachment, pending }: CardProps) {
  const state = useAttachmentUrl(conversationId, attachment);
  const name = attachment.fileName ?? 'Untitled file';
  const size = formatBytes(attachment.size);
  const meta =
    state.status === 'loading' || (state.status === 'unavailable' && pending)
      ? pending
        ? 'Uploading…'
        : 'Preparing…'
      : state.status === 'error'
        ? "Couldn't download"
        : state.status === 'unavailable'
          ? 'Not available on this device'
          : size;
  return (
    <div className={styles.card}>
      <FileText className={styles.cardIcon} size={28} strokeWidth={1.5} aria-hidden />
      <div className={styles.cardText}>
        <span className={styles.cardName} title={name}>
          {name}
        </span>
        <span className={styles.cardMeta}>{meta}</span>
      </div>
      {state.status === 'ready' && (
        <DownloadButton url={state.url} fileName={attachment.fileName} />
      )}
      {state.status === 'error' && (
        <button type="button" className={styles.download} aria-label="Retry" onClick={state.retry}>
          <RotateCw size={16} aria-hidden />
        </button>
      )}
    </div>
  );
}

function AudioCard({ conversationId, attachment, pending }: CardProps) {
  const state = useAttachmentUrl(conversationId, attachment);
  if (state.status !== 'ready')
    return <FileCard conversationId={conversationId} attachment={attachment} pending={pending} />;
  return (
    <div className={styles.card} data-audio="">
      <div className={styles.cardText}>
        <span className={styles.cardName}>{attachment.fileName ?? 'Audio'}</span>
        <audio className={styles.audio} src={state.url} controls preload="metadata" />
      </div>
      <DownloadButton url={state.url} fileName={attachment.fileName} />
    </div>
  );
}
