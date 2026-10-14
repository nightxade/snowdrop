import { Download, FileText, ImageOff, Play, RotateCw } from 'lucide-react';
import { lazy, memo, Suspense, useState, type CSSProperties } from 'react';
import type { Attachment, ConversationId } from '@/core/domain';
import { Tooltip, type LightboxItem } from '@/ui/primitives';
import {
  attachmentFailureCopy,
  attachmentKind,
  fitMedia,
  formatBytes,
  isGridMedia,
  safeHref,
} from '../lib/attachments';
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

// The viewer is only fetched the first time someone opens a photo.
const Lightbox = lazy(() =>
  import('@/ui/primitives/Lightbox').then((m) => ({ default: m.Lightbox })),
);

export const Attachments = memo(function Attachments({
  conversationId,
  attachments,
  pending,
  caption,
}: AttachmentsProps) {
  const media = attachments.filter((a) => isGridMedia(a));
  const others = attachments.filter((a) => !isGridMedia(a));
  const [viewer, setViewer] = useState<number | null>(null);
  // Mounted on first open, then kept: unmounting an open Radix dialog can leave the page inert.
  const [viewerMounted, setViewerMounted] = useState(false);
  if (viewer !== null && !viewerMounted) setViewerMounted(true);
  const open = (a: Attachment) => {
    setViewer(
      Math.max(
        0,
        media.findIndex((item) => item.id === a.id),
      ),
    );
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
      {media.length > 0 && viewerMounted && (
        <Suspense fallback={null}>
          <AttachmentViewer
            conversationId={conversationId}
            media={media}
            index={Math.min(viewer ?? 0, media.length - 1)}
            onIndexChange={setViewer}
            open={viewer !== null}
            onOpenChange={(o) => {
              if (!o) setViewer(null);
            }}
            caption={caption}
          />
        </Suspense>
      )}
    </div>
  );
});

/** Resolve the selected item independently of thumbnail and blob-cache lifetimes. */
function AttachmentViewer({
  conversationId,
  media,
  index,
  ...props
}: {
  conversationId: ConversationId;
  media: readonly Attachment[];
  index: number;
  open: boolean;
  onIndexChange: (index: number) => void;
  onOpenChange: (open: boolean) => void;
  caption?: string | undefined;
}) {
  const selected = media[index];
  if (!selected) throw new Error('Attachment viewer index is out of range');
  const state = useAttachmentUrl(conversationId, selected);
  const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
  const items: LightboxItem[] = media.map((a, i) => {
    const src = i === index && state.status === 'ready' ? state.url : '';
    return {
      src,
      kind: attachmentKind(a) === 'video' ? 'video' : 'image',
      alt: a.fileName ?? 'Attachment',
      fileName: a.fileName,
      downloadHref: src ? safeHref(src) : undefined,
      width: a.width,
      height: a.height,
    };
  });
  return (
    <Lightbox
      {...props}
      items={items}
      index={index}
      mediaStatus={state.status}
      errorLabel={failure?.label}
      onMediaError={state.onMediaError}
      onRetry={failure?.retryable ? state.retry : undefined}
    />
  );
}

function singleStyle(a: Attachment): CSSProperties {
  const box = fitMedia(a);
  return { width: box.width, aspectRatio: `${box.width} / ${box.height}` };
}

interface TileProps {
  conversationId: ConversationId;
  attachment: Attachment;
  pending: boolean;
  more: number;
  onOpen: (a: Attachment) => void;
}

function MediaTile({ conversationId, attachment, pending, more, onOpen }: TileProps) {
  const state = useAttachmentUrl(conversationId, attachment);
  const video = attachmentKind(attachment) === 'video';
  const name = attachment.fileName ?? (video ? 'Video' : 'Image');

  if (state.status !== 'ready') {
    const failed = state.status === 'error' || (state.status === 'unavailable' && !pending);
    const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
    return (
      <div className={styles.tile} data-state={failed ? 'error' : 'loading'} aria-label={name}>
        {failed ? (
          <span className={styles.tileError} title={failure?.detail}>
            <ImageOff size={20} aria-hidden />
            <span>{failure ? failure.label : 'Not available'}</span>
            {failure?.retryable && (
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
        onOpen(attachment);
      }}
    >
      {video ? (
        <>
          <video
            className={styles.media}
            src={state.url}
            preload="metadata"
            muted
            playsInline
            // A "ready" URL that won't load re-resolves once, then shows the
            // error tile with a manual retry (see useAttachmentUrl).
            onError={state.onMediaError}
          />
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
          onError={state.onMediaError}
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
  const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
  const meta =
    state.status === 'loading' || (state.status === 'unavailable' && pending)
      ? pending
        ? 'Uploading…'
        : 'Preparing…'
      : failure
        ? failure.label
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
        <span className={styles.cardMeta} title={failure?.detail}>
          {meta}
        </span>
      </div>
      {state.status === 'ready' && (
        <DownloadButton url={state.url} fileName={attachment.fileName} />
      )}
      {failure?.retryable && (
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
