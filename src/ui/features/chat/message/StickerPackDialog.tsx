import { Check, Download, Sticker as StickerIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { StickerPackDetails } from '@/core/backend';
import type { ConversationId, StickerContent } from '@/core/domain';
import { createLogger } from '@/core/lib';
import { useSnowdrop } from '@/ui/hooks';
import { Button, EmptyState, Modal, Skeleton } from '@/ui/primitives';
import { invalidateStickerPacks } from '../composer/useStickerPacks';
import { StickerThumb } from './StickerThumb';
import { useStickerPack } from './useStickerPack';
import styles from './StickerPackDialog.module.css';

const log = createLogger('ui');

type Install = 'idle' | 'busy' | 'done' | 'error';

export interface StickerPackDialogProps {
  conversationId: ConversationId;
  /** The received sticker the dialog was opened from (identifies the pack). */
  sticker: StickerContent;
  onOpenChange: (open: boolean) => void;
  /** Where focus goes on close (defaults to whatever opened the dialog). */
  returnFocus?: () => HTMLElement | null | undefined;
}

/**
 * The sticker pack behind a received sticker: cover, title, author, every
 * sticker, and an Install button. Install is the user's own explicit action
 * and (like Signal's) also adds the pack on their phone. After it succeeds
 * the composer's picker lists the pack without a restart.
 */
export function StickerPackDialog({
  conversationId,
  sticker,
  onOpenChange,
  returnFocus,
}: StickerPackDialogProps) {
  const { backend } = useSnowdrop();
  const state = useStickerPack(sticker);
  const [install, setInstall] = useState<Install>('idle');
  const mounted = useRef(true);
  const installButton = useRef<HTMLButtonElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const statusId = useId();

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const pack = state.status === 'ready' ? state.pack : undefined;
  const supported =
    backend.installStickerPack !== undefined && backend.supportsStickerPackInstall?.() === true;
  const installed = install === 'done' || pack?.installed === true;

  // The install button is where the user acts; focus it once the pack shows
  // (the dialog opens before the pack has loaded).
  useEffect(() => {
    if (!pack) return;
    const active = document.activeElement;
    if (!active || active === document.body || active.getAttribute('role') === 'dialog')
      installButton.current?.focus({ preventScroll: true });
  }, [pack]);

  const runInstall = () => {
    if (install === 'busy' || installed || !supported || !backend.installStickerPack) return;
    setInstall('busy');
    backend
      .installStickerPack(sticker)
      .then(() => {
        invalidateStickerPacks(backend);
        if (mounted.current) setInstall('done');
      })
      .catch((error: unknown) => {
        log.warn('sticker pack install failed', {
          kind: error instanceof Error ? error.name : 'unknown',
        });
        if (mounted.current) setInstall('error');
      });
  };

  let status: string;
  if (install === 'busy') status = 'Installing…';
  else if (install === 'done') status = 'Installed. It’s in your sticker picker.';
  else if (install === 'error')
    status = 'Couldn’t install this pack. Check your connection and try again.';
  else if (pack?.installed) status = 'This pack is in your sticker picker.';
  else if (!supported)
    status = 'Installing from here needs a newer signal-cli. You can install it in the Signal app.';
  else status = 'Also adds the pack on your phone.';

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      title={pack?.title || 'Sticker pack'}
      {...(pack?.author ? { description: `By ${pack.author}` } : {})}
      size="sm"
      {...(returnFocus ? { returnFocus } : {})}
      footer={
        pack && (
          <div className={styles.footer}>
            <p
              id={statusId}
              className={styles.status}
              role={install === 'error' ? 'alert' : 'status'}
              data-tone={install === 'error' ? 'error' : undefined}
            >
              {status}
            </p>
            <Button
              ref={installButton}
              variant="primary"
              className={styles.install}
              icon={installed ? <Check /> : <Download />}
              aria-disabled={install === 'busy' || installed || !supported ? true : undefined}
              aria-describedby={statusId}
              data-autofocus=""
              onClick={runInstall}
            >
              {installed
                ? 'Installed'
                : install === 'busy'
                  ? 'Installing…'
                  : install === 'error'
                    ? 'Try again'
                    : 'Install'}
            </Button>
          </div>
        )
      }
    >
      <div className={styles.root} data-snowdrop="sticker-pack">
        {state.status === 'loading' && (
          <div aria-busy="true">
            <p className={styles.loading} role="status">
              Loading sticker pack…
            </p>
            <div className={styles.grid} aria-hidden>
              {Array.from({ length: 12 }, (_, i) => (
                <span className={styles.cell} key={i}>
                  <Skeleton width="72%" height="72%" radius="sm" />
                </span>
              ))}
            </div>
          </div>
        )}
        {state.status === 'error' && (
          <EmptyState
            size="sm"
            className={styles.empty}
            icon={<StickerIcon />}
            title="Couldn’t load this sticker pack"
            action={
              <Button size="sm" onClick={state.retry}>
                Try again
              </Button>
            }
          >
            Check that Snowdrop is connected.
          </EmptyState>
        )}
        {pack && (
          <PackBody
            conversationId={conversationId}
            pack={pack}
            scroller={scroller}
            setScroller={setScroller}
          />
        )}
      </div>
    </Modal>
  );
}

function PackBody({
  conversationId,
  pack,
  scroller,
  setScroller,
}: {
  conversationId: ConversationId;
  pack: StickerPackDetails;
  scroller: HTMLDivElement | null;
  setScroller: (el: HTMLDivElement | null) => void;
}) {
  const count = pack.stickers.length;
  return (
    <>
      <div className={styles.summary}>
        <span className={styles.cover}>
          <StickerThumb
            conversationId={conversationId}
            sticker={{ packId: pack.packId, ...pack.cover }}
            root={null}
          />
        </span>
        <span className={styles.count}>{count === 1 ? '1 sticker' : `${count} stickers`}</span>
      </div>
      <div
        className={styles.viewport}
        ref={setScroller}
        tabIndex={0}
        role="region"
        aria-label="Stickers in this pack"
      >
        <ul className={styles.grid}>
          {pack.stickers.map((s) => (
            <li
              key={s.stickerId}
              className={styles.cell}
              aria-label={s.emoji ? `${s.emoji} sticker` : 'Sticker'}
            >
              <StickerThumb
                conversationId={conversationId}
                sticker={{ packId: pack.packId, ...s }}
                root={scroller}
                lazy
              />
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
