import {
  Download,
  FileText,
  Link as LinkIcon,
  Loader2,
  MessageSquare,
  Mic,
  Music,
  Play,
  RotateCw,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MessageRef } from '@/core/backend';
import {
  isVoiceNote,
  type ConversationId,
  type GalleryItem,
  type GallerySection,
} from '@/core/domain';
import { IconButton } from '@/ui/primitives';
import { attachmentFailureCopy, formatBytes, safeHref } from '../lib/attachments';
import { previewDomain } from '../lib/linkPreviews';
import { useAttachmentUrl, type AttachmentUrlState } from '../message/useAttachmentUrl';
import { useIncomingMediaHeld } from '../message/useMediaHold';
import type { ItemMeta } from './useItemMeta';
import { useNearView } from './useNearView';
import styles from './GalleryRows.module.css';

type AttachmentItem = Extract<GalleryItem, { type: 'attachment' }>;
type LinkItem = Extract<GalleryItem, { type: 'link' }>;

interface RowsProps<T extends GalleryItem> {
  conversationId: ConversationId;
  sections: readonly GallerySection[];
  describe: (item: T) => ItemMeta;
  onJump: (item: T) => void;
}

/** Date-grouped list shared by the Audio, Files and Links tabs. */
function Sections({
  sections,
  row,
}: {
  sections: readonly GallerySection[];
  row: (item: GalleryItem) => ReactNode;
}) {
  return (
    <div className={styles.sections}>
      {sections.map((section) => (
        <section key={section.key} className={styles.section} aria-labelledby={`g-${section.key}`}>
          <h3 id={`g-${section.key}`} className={styles.heading}>
            {section.label}
          </h3>
          <ul className={styles.list}>{section.items.map(row)}</ul>
        </section>
      ))}
    </div>
  );
}

function Row({
  icon,
  title,
  subtitle,
  meta,
  actions,
  below,
}: {
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  meta: string;
  actions: ReactNode;
  below?: ReactNode;
}) {
  return (
    <li className={styles.row}>
      <span className={styles.leading} aria-hidden>
        {icon}
      </span>
      <div className={styles.text}>
        <span className={styles.title}>{title}</span>
        {subtitle && <span className={styles.subtitle}>{subtitle}</span>}
        <span className={styles.meta}>{meta}</span>
      </div>
      <div className={styles.actions}>{actions}</div>
      {below && <div className={styles.below}>{below}</div>}
    </li>
  );
}

function JumpButton({ onJump }: { onJump: () => void }) {
  return (
    <IconButton
      label="Go to message"
      icon={<MessageSquare />}
      size="sm"
      tooltipSide="bottom"
      onClick={onJump}
    />
  );
}

const refOf = (item: AttachmentItem | LinkItem): MessageRef => ({
  authorId: item.message.authorId,
  sentAt: item.message.sentAt,
});

/** Text for a resolve that is not ready (and not a held message-request item). */
function progressText(state: AttachmentUrlState): string | undefined {
  switch (state.status) {
    case 'loading':
      return 'Preparing…';
    case 'backfilling':
      return 'Getting it from your phone…';
    case 'unavailable':
      return 'Not available on this device';
    case 'error':
      return attachmentFailureCopy(state.kind).label;
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------- Audio

export function AudioRows({
  conversationId,
  sections,
  describe,
  onJump,
}: RowsProps<AttachmentItem>) {
  return (
    <Sections
      sections={sections}
      row={(item) =>
        item.type === 'attachment' ? (
          <AudioRow
            key={item.key}
            conversationId={conversationId}
            item={item}
            meta={describe(item)}
            onJump={onJump}
          />
        ) : null
      }
    />
  );
}

function AudioRow({
  conversationId,
  item,
  meta,
  onJump,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  meta: ItemMeta;
  onJump: (item: AttachmentItem) => void;
}) {
  const { attachment } = item;
  const voice = isVoiceNote(attachment);
  const name = voice ? 'Voice message' : (attachment.fileName ?? 'Audio');
  const size = formatBytes(attachment.size);
  // Nothing is fetched until play is pressed for this row.
  const [wanted, setWanted] = useState(false);
  const Icon: LucideIcon = voice ? Mic : Music;
  return (
    <Row
      icon={<Icon size={20} aria-hidden />}
      title={name}
      meta={[meta.author, meta.when, size].filter(Boolean).join(' · ')}
      actions={
        <>
          {!wanted && (
            <IconButton
              label={`Play ${name}`}
              icon={<Play />}
              size="sm"
              tooltipSide="bottom"
              onClick={() => {
                setWanted(true);
              }}
            />
          )}
          <JumpButton
            onJump={() => {
              onJump(item);
            }}
          />
        </>
      }
      below={
        wanted ? <AudioPlayback conversationId={conversationId} item={item} name={name} /> : null
      }
    />
  );
}

function AudioPlayback({
  conversationId,
  item,
  name,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  name: string;
}) {
  const state = useAttachmentUrl(
    conversationId,
    refOf(item),
    item.attachment,
    item.message.attachments.map((a) => a.id),
  );
  if (state.status === 'ready')
    return (
      <audio
        className={styles.audio}
        src={state.url}
        controls
        autoPlay
        preload="auto"
        aria-label={name}
        onError={state.onMediaError}
      />
    );
  return <Pending state={state} what={name} />;
}

/** Status line with the action its state allows: download when held, retry when worth it. */
function Pending({ state, what }: { state: AttachmentUrlState & ActionSet; what: string }) {
  if (state.status === 'held')
    return (
      <button type="button" className={styles.inline} onClick={state.download}>
        <Download size={14} aria-hidden /> Download {what}
      </button>
    );
  const failure = state.status === 'error' ? attachmentFailureCopy(state.kind) : undefined;
  return (
    <span className={styles.progress} role="status" title={failure?.detail}>
      {(state.status === 'loading' || state.status === 'backfilling') && (
        <Loader2 size={14} className={styles.spin} aria-hidden />
      )}
      {progressText(state)}
      {failure?.retryable && (
        <button type="button" className={styles.inline} onClick={state.retry}>
          <RotateCw size={14} aria-hidden /> Retry
        </button>
      )}
    </span>
  );
}

interface ActionSet {
  retry: () => void;
  download: () => void;
}

// ---------------------------------------------------------------- Files

export function FileRows({
  conversationId,
  sections,
  describe,
  onJump,
}: RowsProps<AttachmentItem>) {
  return (
    <Sections
      sections={sections}
      row={(item) =>
        item.type === 'attachment' ? (
          <FileRow
            key={item.key}
            conversationId={conversationId}
            item={item}
            meta={describe(item)}
            onJump={onJump}
          />
        ) : null
      }
    />
  );
}

function FileRow({
  conversationId,
  item,
  meta,
  onJump,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  meta: ItemMeta;
  onJump: (item: AttachmentItem) => void;
}) {
  const { attachment } = item;
  const name = attachment.fileName ?? 'Untitled file';
  const size = formatBytes(attachment.size);
  const [wanted, setWanted] = useState(false);
  return (
    <Row
      icon={<FileText size={22} strokeWidth={1.5} aria-hidden />}
      title={<span title={name}>{name}</span>}
      meta={[size, meta.author, meta.when].filter(Boolean).join(' · ')}
      actions={
        <>
          {wanted ? (
            <FileSave conversationId={conversationId} item={item} name={name} />
          ) : (
            <IconButton
              label={`Download ${name}`}
              icon={<Download />}
              size="sm"
              tooltipSide="bottom"
              onClick={() => {
                setWanted(true);
              }}
            />
          )}
          <JumpButton
            onJump={() => {
              onJump(item);
            }}
          />
        </>
      }
    />
  );
}

/**
 * Fetches the file once asked, then hands it to the browser's own download
 * (the same `<a download>` the message's file card uses). The link stays on
 * screen afterwards in case the webview ignored the automatic click.
 */
function FileSave({
  conversationId,
  item,
  name,
}: {
  conversationId: ConversationId;
  item: AttachmentItem;
  name: string;
}) {
  const state = useAttachmentUrl(
    conversationId,
    refOf(item),
    item.attachment,
    item.message.attachments.map((a) => a.id),
  );
  const link = useRef<HTMLAnchorElement>(null);
  const url = state.status === 'ready' ? state.url : undefined;
  const saved = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (url === undefined || saved.current === url) return;
    saved.current = url;
    link.current?.click();
  }, [url]);
  const href = safeHref(url);
  if (href)
    return (
      <a
        ref={link}
        className={styles.save}
        href={href}
        download={item.attachment.fileName ?? true}
        aria-label={`Save ${name}`}
        title="Save"
      >
        <Download size={16} aria-hidden />
      </a>
    );
  return <Pending state={state} what={name} />;
}

// ---------------------------------------------------------------- Links

export function LinkRows({ conversationId, sections, describe, onJump }: RowsProps<LinkItem>) {
  return (
    <Sections
      sections={sections}
      row={(item) =>
        item.type === 'link' ? (
          <LinkRow
            key={item.key}
            conversationId={conversationId}
            item={item}
            meta={describe(item)}
            onJump={onJump}
          />
        ) : null
      }
    />
  );
}

function LinkRow({
  conversationId,
  item,
  meta,
  onJump,
}: {
  conversationId: ConversationId;
  item: LinkItem;
  meta: ItemMeta;
  onJump: (item: LinkItem) => void;
}) {
  const { preview, message } = item;
  const domain = previewDomain(preview.url);
  // A message request's links are shown but never followed (see LinkPreviewCard).
  const held = useIncomingMediaHeld(conversationId, message.authorId);
  return (
    <Row
      icon={<LinkThumb conversationId={conversationId} item={item} held={held} />}
      title={preview.title ?? domain}
      subtitle={
        held ? (
          <span className={styles.url}>{preview.url}</span>
        ) : (
          <a
            className={styles.url}
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer nofollow"
          >
            {preview.url}
          </a>
        )
      }
      meta={[domain, meta.author, meta.when].join(' · ')}
      actions={
        <JumpButton
          onJump={() => {
            onJump(item);
          }}
        />
      }
    />
  );
}

function LinkThumb({
  conversationId,
  item,
  held,
}: {
  conversationId: ConversationId;
  item: LinkItem;
  held: boolean;
}) {
  const [ref, near] = useNearView<HTMLSpanElement>();
  const image = item.preview.image;
  return (
    <span ref={ref} className={styles.thumb}>
      {near && !held && image ? (
        <LinkImage conversationId={conversationId} item={item} />
      ) : (
        <LinkIcon size={18} aria-hidden />
      )}
    </span>
  );
}

function LinkImage({ conversationId, item }: { conversationId: ConversationId; item: LinkItem }) {
  const image = item.preview.image;
  if (!image) throw new Error('LinkImage needs a preview image');
  const state = useAttachmentUrl(conversationId, refOf(item), image);
  if (state.status !== 'ready') return <LinkIcon size={18} aria-hidden />;
  return (
    <img
      className={styles.thumbImage}
      src={state.url}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={state.onMediaError}
    />
  );
}
