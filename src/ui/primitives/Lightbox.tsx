import * as RadixDialog from '@radix-ui/react-dialog';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { useRef, type KeyboardEvent } from 'react';
import { IconButton } from './IconButton';
import styles from './Lightbox.module.css';

export interface LightboxItem {
  /** Render-only URL: used as an <img>/<video> source or <a download> target, never navigated to. */
  src: string;
  kind: 'image' | 'video';
  /** Accessible description, usually the file name. */
  alt: string;
  fileName?: string | undefined;
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
}

/** Full-screen media viewer on the dialog primitive: ←/→ between items, Esc closes. */
export function Lightbox({
  items,
  index,
  onIndexChange,
  open,
  onOpenChange,
  caption,
}: LightboxProps) {
  const item = items[index];
  const opener = useRef<HTMLElement | null>(null);
  const many = items.length > 1;
  const step = (delta: number) => {
    if (!many) return;
    onIndexChange((index + delta + items.length) % items.length);
  };
  const onKeyDown = (event: KeyboardEvent) => {
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
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null;
            (e.currentTarget as HTMLElement | null)?.focus();
          }}
          onCloseAutoFocus={(e) => {
            // Back to the thumbnail that opened it (the dialog had no Radix trigger).
            if (opener.current?.isConnected) {
              e.preventDefault();
              opener.current.focus();
            }
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
            {item && (
              <a
                className={styles.download}
                href={item.src}
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
            {item?.kind === 'video' ? (
              <video
                key={item.src}
                className={styles.media}
                src={item.src}
                controls
                autoPlay
                aria-label={item.alt}
              />
            ) : item ? (
              <img
                key={item.src}
                className={styles.media}
                src={item.src}
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
