import { useEffect, useMemo, useRef, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { MessageId } from '@/core/domain';
import type { ListNavigation } from '../ChatController';
import type { MessageAction, RowState } from './rowState';

/** Ctrl+E / Ctrl+Y scroll step: about one line of message text. */
const LINE_PX = 40;

export interface ListNavigationDeps {
  scroller: RefObject<HTMLElement | null>;
  virtuoso: RefObject<VirtuosoHandle | null>;
  rows: RowState;
  jumpToPresent: () => Promise<void>;
  /** Loads older history (when there is any). */
  loadOlder: () => void;
  reducedMotion: () => boolean;
}

/** After the virtualiser has rendered rows for a new scroll position. */
function afterRender(fn: () => void): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(fn);
  });
}

/**
 * Keyboard navigation over the rendered message rows, for commands and key
 * layers (Vim's j/k, gg/G, Ctrl+D/U/E/Y, zz and message actions). Works on
 * the DOM rows the virtualiser has mounted, the same set ↑/↓ walks. The
 * returned object is stable; it always uses the latest dependencies.
 */
export function useListNavigation(deps: ListNavigationDeps): ListNavigation {
  const latest = useRef(deps);
  useEffect(() => {
    latest.current = deps;
  });

  return useMemo<ListNavigation>(() => {
    const d = () => latest.current;
    const rowEls = () => [
      ...(d().scroller.current?.querySelectorAll<HTMLElement>('[data-roving-item]') ?? []),
    ];
    const focusedRow = (): HTMLElement | null => {
      const a = document.activeElement;
      return a instanceof HTMLElement &&
        a.hasAttribute('data-roving-item') &&
        d().scroller.current?.contains(a)
        ? a
        : null;
    };
    const tabStop = () => {
      const all = rowEls();
      return all.find((el) => el.dataset.messageId === d().rows.activeId) ?? all.at(-1) ?? null;
    };
    const focusRow = (el: HTMLElement, block: ScrollLogicalPosition | false = 'nearest') => {
      const id = el.dataset.messageId as MessageId | undefined;
      if (id) d().rows.setActive(id);
      el.focus({ preventScroll: true });
      if (block) el.scrollIntoView({ block });
    };
    const visible = (el: HTMLElement, view: DOMRect) => {
      const box = el.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom;
    };

    return {
      navigate(to, count) {
        if (to === 'first') {
          d().loadOlder();
          d().virtuoso.current?.scrollToIndex({ index: 0, align: 'start', behavior: 'auto' });
          afterRender(() => {
            const first = rowEls()[0];
            if (first) focusRow(first, 'start');
          });
          return true;
        }
        if (to === 'last') {
          void d()
            .jumpToPresent()
            .then(() => {
              afterRender(() => {
                const last = rowEls().at(-1);
                if (last) focusRow(last, 'end');
              });
            });
          return true;
        }
        const current = focusedRow();
        if (!current) {
          // From outside the list, the first press lands on its tab stop.
          const stop = tabStop();
          if (stop) focusRow(stop);
          return stop !== null;
        }
        const all = rowEls();
        const i = all.indexOf(current);
        const j = to === 'next' ? i + count : i - count;
        // Above the first rendered row: nudge the scroller so older rows render (and load).
        if (j < 0) d().scroller.current?.scrollBy({ top: -200 });
        const target = all[Math.max(0, Math.min(all.length - 1, j))];
        if (target && target !== current) focusRow(target);
        return true;
      },

      scroll(by, direction, count) {
        const el = d().scroller.current;
        if (!el) return;
        const current = focusedRow();
        const top = el.getBoundingClientRect().top;
        const offset = current ? current.getBoundingClientRect().top - top : el.clientHeight / 2;
        const delta = by === 'halfPage' ? (el.clientHeight / 2) * count : LINE_PX * count;
        el.scrollBy({ top: direction * delta, behavior: 'auto' });
        afterRender(() => {
          const view = el.getBoundingClientRect();
          const all = rowEls().filter((r) => visible(r, view));
          if (all.length === 0) return;
          if (by === 'line') {
            // Like Vim's Ctrl+E: the cursor only moves when its row scrolls out of view.
            if (!current || visible(current, view)) return;
            focusRow((direction > 0 ? all[0] : all.at(-1)) as HTMLElement, false);
            return;
          }
          // Half page: focus the row at the same height the focused one was.
          const y = view.top + Math.max(0, Math.min(el.clientHeight - 1, offset));
          const target =
            all.find((r) => {
              const box = r.getBoundingClientRect();
              return box.top <= y && box.bottom > y;
            }) ?? (direction > 0 ? all.at(-1) : all[0]);
          if (target) focusRow(target, 'nearest');
        });
      },

      center() {
        const row = focusedRow() ?? tabStop();
        if (!row) return;
        if (row !== document.activeElement) focusRow(row, false);
        row.scrollIntoView({ block: 'center', behavior: d().reducedMotion() ? 'auto' : 'smooth' });
      },

      act(action: MessageAction) {
        const row = focusedRow() ?? tabStop();
        const id = row?.dataset.messageId as MessageId | undefined;
        if (!row || !id) return false;
        if (row !== document.activeElement) focusRow(row);
        return d().rows.runAction(id, action);
      },

      focus() {
        const stop = tabStop();
        if (stop) focusRow(stop);
        else d().scroller.current?.focus();
      },
    };
  }, []);
}
