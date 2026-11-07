import * as RadixDialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import type { KeyboardEvent } from 'react';
import { Button } from './Button';
import { IconButton } from './IconButton';
import { useOpenerFocus } from './openerFocus';
import styles from './Lightbox.module.css';

export interface LightboxItem {
  /** Render-only URL: used as an <img>/<video> source or <a download> target, never navigated to. */
  src: string;
  kind: 'image' | 'video';
  /** Accessible description, usually the file name. */
  alt: string;
  fileName?: string | undefined;
  /** Download link; omitted when the URL isn't safe to link to. */
  downloadHref?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
}

export interface LightboxProps {
  items: readonly LightboxItem[];
  index: number;
  onIndexChange: (index: number) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "Shared by Mira · Today at 14:02" */
  caption?: string | undefined;
  mediaStatus?: 'ready' | 'loading' | 'backfilling' | 'error' | 'unavailable';
  /** A few words for why loading/`mediaStatus === 'error'` failed; a generic fallback otherwise. */
  errorLabel?: string | undefined;
  onMediaError?: () => void;
  /** Omitted (no Retry button shown) when the failure is permanent. */
  onRetry?: (() => void) | undefined;
  /** The retry button's text; "Retry" by default. */
  retryLabel?: string | undefined;
}

/** Whether this element uses Left and Right itself (seeking, caret movement). */
function ownsArrowKeys(target: EventTarget): boolean {
  return (
    target instanceof HTMLElement &&
    (target.closest('video, audio, input, textarea, select') !== null || target.isContentEditable)
  );
}

/** Full-screen media viewer on the dialog primitive: ←/→ between items, Esc closes. */
export function Lightbox({
  items,
  index,
  onIndexChange,
  open,
  onOpenChange,
  caption,
  mediaStatus = 'ready',
  errorLabel,
  onMediaError,
  onRetry,
  retryLabel = 'Retry',
}: LightboxProps) {
  const item = items[index];
  const focus = useOpenerFocus(open);
  const many = items.length > 1;
  const step = (delta: number) => {
    if (!many) return;
    onIndexChange((index + delta + items.length) % items.length);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    // A focused video seeks with Left and Right; text fields move their caret.
    if (ownsArrowKeys(event.target)) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      step(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      step(-1);
    }
  };

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={styles.overlay} />
        <RadixDialog.Content
          className={styles.content}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            // Focus the viewer itself: a focused Close button would open its tooltip,
            // which then swallows the first Escape.
            e.preventDefault();
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Back to the thumbnail that opened it (the dialog had no Radix trigger).
            focus.closeFocus(e);
          }}
        >
          <RadixDialog.Title className={styles.title}>
            {item?.alt ?? 'Attachment'}
          </RadixDialog.Title>
          <RadixDialog.Description className={styles.caption}>
            {[caption, many ? `${index + 1} of ${items.length}` : null]
              .filter(Boolean)
              .join(' · ') || ' '}
          </RadixDialog.Description>
          <div className={styles.bar}>
            {item?.downloadHref && (
              <a
                className={styles.download}
                href={item.downloadHref}
                download={item.fileName ?? true}
                aria-label="Download"
                title="Download"
              >
                <Download size={20} aria-hidden />
              </a>
            )}
            <RadixDialog.Close asChild>
              <IconButton
                label="Close"
                icon={<X />}
                tooltipSide="bottom"
                className={styles.close}
              />
            </RadixDialog.Close>
          </div>
          <div
            className={styles.stage}
            onClick={(e) => {
              // Clicking the backdrop around the media closes, like a scrim.
              if (e.target === e.currentTarget) onOpenChange(false);
            }}
          >
            {mediaStatus !== 'ready' ? (
              <div role="status">
                <p>
                  {mediaStatus === 'loading'
                    ? 'Loading attachment…'
                    : mediaStatus === 'backfilling'
                      ? 'Getting it from your phone…'
                      : mediaStatus === 'unavailable'
                        ? 'Not available on this device'
                        : (errorLabel ?? "Couldn't load attachment")}
                </p>
                {mediaStatus === 'error' && onRetry && (
                  <Button onClick={onRetry}>{retryLabel}</Button>
                )}
              </div>
            ) : item?.kind === 'video' ? (
              <video
                key={item.src}
                className={styles.media}
                src={item.src}
                onError={onMediaError}
                controls
                autoPlay
                aria-label={item.alt}
              />
            ) : item ? (
              <img
                key={item.src}
                className={styles.media}
                src={item.src}
                onError={onMediaError}
                alt={item.alt}
                {...(item.width ? { width: item.width } : {})}
                {...(item.height ? { height: item.height } : {})}
                draggable={false}
              />
            ) : null}
          </div>
          {many && (
            <>
              <button
                type="button"
                className={styles.nav}
                data-side="prev"
                aria-label="Previous"
                onClick={() => {
                  step(-1);
                }}
              >
                <ChevronLeft size={28} aria-hidden />
              </button>
              <button
                type="button"
                className={styles.nav}
                data-side="next"
                aria-label="Next"
                onClick={() => {
                  step(1);
                }}
              >
                <ChevronRight size={28} aria-hidden />
              </button>
            </>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
