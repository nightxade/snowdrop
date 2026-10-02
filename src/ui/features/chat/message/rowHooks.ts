import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Message } from '@/core/domain';
import { UNKNOWN_CONTACT_NAME } from '@/core/stores';
import { useStores } from '@/ui/hooks';

const FOCUSABLE =
  'button, a[href], input, textarea, select, video[controls], audio[controls], [tabindex]';
const INERT = 'data-row-inert';

/**
 * Keeps a message row a single tab stop: its inner controls (name, avatar,
 * mention pills, attachments, reactions, hover bar) are `tabindex=-1` until
 * the user enters the row (Enter), and go back when they leave it. Content
 * that appears later (a resolved image, a revealed spoiler) is caught by a
 * MutationObserver.
 */
export function useInertUntilEntered(row: RefObject<HTMLElement | null>, entered: boolean): void {
  useLayoutEffect(() => {
    const el = row.current;
    if (!el) return;
    const apply = () => {
      for (const node of el.querySelectorAll<HTMLElement>(FOCUSABLE)) {
        if (node === el) continue;
        if (entered) {
          const original = node.getAttribute(INERT);
          if (original === null) continue;
          if (original === '') node.removeAttribute('tabindex');
          else node.setAttribute('tabindex', original);
          node.removeAttribute(INERT);
        } else if (!node.hasAttribute(INERT) && node.getAttribute('tabindex') !== '-1') {
          node.setAttribute(INERT, node.getAttribute('tabindex') ?? '');
          node.setAttribute('tabindex', '-1');
        }
      }
    };
    apply();
    if (entered || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(apply);
    observer.observe(el, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
    };
  });
}

/** First control inside a row, in DOM order (the hover bar comes first). */
export function firstControl(row: HTMLElement): HTMLElement | null {
  return row.querySelector<HTMLElement>(
    'button:not([disabled]), a[href], input, textarea, video[controls], audio[controls]',
  );
}

const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

/** Touch long-press (≥ 450 ms without moving) → `onLongPress`. */
export function useLongPress(onLongPress: () => void) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    origin.current = null;
  }, []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === 'mouse') return;
      cancel();
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      const o = origin.current;
      if (o && Math.hypot(e.clientX - o.x, e.clientY - o.y) > MOVE_TOLERANCE_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
  };
}

/**
 * Display names for exactly the people a message refers to (author,
 * mentions, quote, reactors, deleter, failed recipients). A row subscribes
 * to those names only, so an unrelated contact update doesn't re-render it.
 */
export function useMessageNames(m: Message | undefined): (id: string) => string {
  const stores = useStores();
  const ids = useMemo(() => {
    if (!m) return [];
    const set = new Set<string>([m.authorId]);
    for (const r of m.ranges) if (r.mentionId !== undefined) set.add(r.mentionId);
    if (m.quote) {
      set.add(m.quote.authorId);
      for (const r of m.quote.ranges ?? []) if (r.mentionId !== undefined) set.add(r.mentionId);
    }
    for (const r of m.reactions) set.add(r.authorId);
    if (m.deletedBy !== undefined) set.add(m.deletedBy);
    for (const id of m.failedRecipients ?? []) set.add(id);
    return [...set];
  }, [m]);
  const names = useStore(
    stores.contacts,
    useShallow((s) => ids.map((id) => s.byId[id]?.name ?? UNKNOWN_CONTACT_NAME)),
  );
  return useMemo(() => {
    const map = new Map(ids.map((id, i) => [id, names[i] ?? UNKNOWN_CONTACT_NAME]));
    return (id: string) => map.get(id) ?? UNKNOWN_CONTACT_NAME;
  }, [ids, names]);
}
