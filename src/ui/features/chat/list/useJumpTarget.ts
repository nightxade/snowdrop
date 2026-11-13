import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { MessageId, RenderItem } from '@/core/domain';
import type { RowState } from './rowState';

export interface JumpTarget {
  id: MessageId;
  flash: boolean;
  focus: boolean;
}

const FLASH_MS = 1600;
/** After the (possibly smooth) scroll has rendered the row. */
const FOCUS_DELAY_MS = 350;

interface Options {
  items: readonly RenderItem[];
  virtuoso: RefObject<VirtuosoHandle | null>;
  scroller: RefObject<HTMLElement | null>;
  rows: RowState;
  reducedMotion: () => boolean;
}

/**
 * The jump-to-message lifecycle: the pending target, the scroll once it is
 * loaded, its flash and its (cancellable) focus. Every timer is released by
 * one cleanup. Each target is tagged with a sequence number so a stale
 * request (a reveal that failed after a newer one took over) cannot clear
 * the newer target.
 */
export function useJumpTarget({ items, virtuoso, scroller, rows, reducedMotion }: Options) {
  const [target, setTargetState] = useState<JumpTarget | null>(null);
  const sequence = useRef(0);
  // The latest scheduled focus-after-scroll, so a second "jump to" within
  // 350ms can cancel the first one instead of letting it land on a stale row.
  const pendingFocus = useRef<{ id: MessageId; timer: ReturnType<typeof setTimeout> } | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Sets the target and returns its sequence token. */
  const setTarget = useCallback((next: JumpTarget): number => {
    sequence.current += 1;
    setTargetState(next);
    return sequence.current;
  }, []);

  /** Clears the target only if `token` is still the latest request. */
  const clearTarget = useCallback((token: number) => {
    if (token === sequence.current) setTargetState(null);
  }, []);

  // A pending jump whose target is now loaded: scroll to it, flash it, maybe focus it.
  useEffect(() => {
    if (!target) return;
    const index = items.findIndex((it) => 'id' in it && it.id === target.id);
    if (index < 0) return;
    const { id, flash, focus } = target;
    const frame = requestAnimationFrame(() => {
      virtuoso.current?.scrollToIndex({
        index,
        align: 'center',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      });
      if (flash) {
        rows.flash(id);
        if (flashTimer.current) clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => {
          flashTimer.current = null;
          if (rows.isFlashing(id)) rows.flash(null);
        }, FLASH_MS);
      }
      if (focus) {
        rows.setActive(id);
        if (pendingFocus.current) clearTimeout(pendingFocus.current.timer);
        const timer = setTimeout(() => {
          // Only focus if nothing superseded this jump in the meantime.
          if (pendingFocus.current?.timer !== timer) return;
          pendingFocus.current = null;
          scroller.current
            ?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`)
            ?.focus({ preventScroll: true });
        }, FOCUS_DELAY_MS);
        pendingFocus.current = { id, timer };
      }
      setTargetState(null);
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [target, items, rows, virtuoso, scroller, reducedMotion]);

  // Release any still-pending timer if the list unmounts first.
  useEffect(
    () => () => {
      if (pendingFocus.current) clearTimeout(pendingFocus.current.timer);
      if (flashTimer.current) clearTimeout(flashTimer.current);
    },
    [],
  );

  return { target, setTarget, clearTarget };
}
