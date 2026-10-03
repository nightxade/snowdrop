import { useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { ComposerSlotProps } from '@/core/plugins';
import type { Mode } from '../engine/engine';
import type { ModeSnapshot, ModeStore } from '../modeStore';
import styles from '../vim.module.css';
import { caretCell, sameCell, type CaretCell } from './caretCell';
import { createMirror, type Mirror } from './mirror';

/** Stable style hooks: the composer root (positioned) and its field. */
const ROOT = '[data-shrike="composer"]';
const FIELD = 'textarea[data-shrike="composer-input"]';

/** Font properties the drawn character copies from the field, so it sits exactly on the glyph. */
const FONT = [
  'fontFamily',
  'fontSize',
  'fontStyle',
  'fontWeight',
  'fontStretch',
  'fontFeatureSettings',
  'fontVariationSettings',
  'letterSpacing',
  'lineHeight',
] as const;
type Font = Partial<Record<(typeof FONT)[number], string>>;

export interface BlockCaretDeps {
  modes: ModeStore;
  /** Other changes that can move the text (the draft, the font scale). */
  subscribe: (fn: () => void) => () => void;
  /** For tests: a measurer that doesn't need real layout. */
  createMirror?: () => Mirror;
}

interface CaretView {
  mode: Mode;
  focused: boolean;
  /** The field's padding box, relative to the composer root. */
  layer: { left: number; top: number; width: number; height: number };
  /** The cell, already shifted by the field's scroll. */
  cell: CaretCell;
  font: Font;
}

/**
 * Vim's block cursor for the composer in Normal and Visual modes. A
 * textarea can only draw a thin caret or a selection, and a one-character
 * selection vanishes where there's no character (empty field, end of line,
 * a blank line), so the block is drawn over the field instead: an
 * absolutely positioned cell, measured with a mirror of the field
 * (`mirror.ts`) and clipped to the field's padding box. Hidden in Insert
 * mode (the native caret is back); hollow while the composer is unfocused.
 *
 * Rendered as a composer accessory: an empty anchor in the accessory slot
 * finds its composer, and the block is portalled into the composer root.
 */
export function makeBlockCaret(deps: BlockCaretDeps) {
  return function VimBlockCaret({ conversationId }: ComposerSlotProps) {
    const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
    const snapshot = useSyncExternalStore(deps.modes.subscribe, () =>
      deps.modes.get(conversationId),
    );
    const root = anchor?.closest<HTMLElement>(ROOT) ?? null;
    const field = root?.querySelector<HTMLTextAreaElement>(FIELD) ?? null;
    const view = useCaretView(root, field, snapshot, deps);
    return (
      <>
        <span ref={setAnchor} hidden />
        {root && view && createPortal(<CaretLayer view={view} />, root)}
      </>
    );
  };
}

function CaretLayer({ view }: { view: CaretView }) {
  const { layer, cell, font } = view;
  const style: CSSProperties = { ...layer, ...font };
  const block: CSSProperties = {
    left: cell.left,
    top: cell.top,
    width: cell.width,
    height: cell.height,
    lineHeight: `${cell.height}px`,
  };
  return (
    <div className={styles.caretLayer} style={style} aria-hidden data-shrike="vim-caret-layer">
      <span
        // A new element per position restarts the blink: the block stays solid while it moves.
        key={`${cell.start}:${cell.left}:${cell.top}`}
        className={styles.caret}
        style={block}
        data-shrike="vim-caret"
        data-vim-mode={view.mode}
        data-focused={view.focused ? 'true' : 'false'}
      >
        {view.focused ? cell.char : ''}
      </span>
    </div>
  );
}

/** The field's position inside the composer root, in layout px (offsets, so CSS zoom can't skew it). */
function offsetWithin(el: HTMLElement, root: HTMLElement): { left: number; top: number } {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== root) {
    left += node.offsetLeft;
    top += node.offsetTop;
    const parent = node.offsetParent as HTMLElement | null;
    if (parent && parent !== root) {
      left += parent.clientLeft;
      top += parent.clientTop;
    }
    if (parent && !root.contains(parent)) {
      // The root isn't positioned after all: fall back to rects.
      const a = el.getBoundingClientRect();
      const b = root.getBoundingClientRect();
      return { left: a.left - b.left, top: a.top - b.top };
    }
    node = parent;
  }
  return { left, top };
}

function sameView(a: CaretView | null, b: CaretView | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const la = a.layer;
  const lb = b.layer;
  return (
    a.mode === b.mode &&
    a.focused === b.focused &&
    la.left === lb.left &&
    la.top === lb.top &&
    la.width === lb.width &&
    la.height === lb.height &&
    sameCell(a.cell, b.cell) &&
    FONT.every((k) => a.font[k] === b.font[k])
  );
}

function computeView(
  root: HTMLElement,
  field: HTMLTextAreaElement,
  snapshot: ModeSnapshot,
  mirror: Mirror,
): CaretView | null {
  const mode = snapshot.mode;
  if (mode === null || mode === 'insert' || !field.isConnected) return null;
  const text = field.value;
  // Normal mode shows a one-character selection at the cursor, so the field
  // is the truth (it also follows a send that cleared it). In Visual mode
  // the cursor is the selection's moving end, which only the engine knows.
  const offset =
    mode === 'normal' ? Math.min(field.selectionStart, field.selectionEnd) : snapshot.cursor;
  const cell = caretCell(text, offset, mirror.measure(field));
  const at = offsetWithin(field, root);
  const style = getComputedStyle(field);
  const font: Font = {};
  for (const k of FONT) font[k] = style[k];
  return {
    mode,
    focused: field.ownerDocument.activeElement === field,
    layer: {
      left: at.left + field.clientLeft,
      top: at.top + field.clientTop,
      width: field.clientWidth,
      height: field.clientHeight,
    },
    cell: { ...cell, left: cell.left - field.scrollLeft, top: cell.top - field.scrollTop },
    font,
  };
}

/**
 * Keeps the block's geometry current: recomputed at once when the mode or
 * cursor changes (no lag behind a key), and on the next frame after
 * anything else that can move it (typing, scrolling, focus, a resize, the
 * draft or font scale changing, web fonts arriving).
 */
function useCaretView(
  root: HTMLElement | null,
  field: HTMLTextAreaElement | null,
  snapshot: ModeSnapshot,
  deps: BlockCaretDeps,
): CaretView | null {
  const [view, setView] = useState<CaretView | null>(null);
  const latest = useRef(snapshot);
  const mirror = useRef<Mirror | null>(null);
  const update = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    latest.current = snapshot;
    update.current();
  }, [snapshot]);

  useLayoutEffect(() => {
    if (!root || !field) return;
    const m = (mirror.current ??= (deps.createMirror ?? createMirror)());
    update.current = () => {
      const next = computeView(root, field, latest.current, m);
      setView((prev) => (sameView(prev, next) ? prev : next));
    };
    update.current();

    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update.current();
      });
    };
    const onSelection = () => {
      if (field.ownerDocument.activeElement === field) schedule();
    };
    const events = ['scroll', 'input', 'select', 'focus', 'blur'] as const;
    for (const e of events) field.addEventListener(e, schedule);
    const doc = field.ownerDocument;
    doc.addEventListener('selectionchange', onSelection);
    const win = doc.defaultView;
    win?.addEventListener('resize', schedule);
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    resize?.observe(field);
    resize?.observe(root);
    const fonts = 'fonts' in doc ? doc.fonts : null;
    fonts?.addEventListener('loadingdone', schedule);
    const unsubscribe = deps.subscribe(schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      for (const e of events) field.removeEventListener(e, schedule);
      doc.removeEventListener('selectionchange', onSelection);
      win?.removeEventListener('resize', schedule);
      resize?.disconnect();
      fonts?.removeEventListener('loadingdone', schedule);
      unsubscribe();
      update.current = () => undefined;
    };
  }, [root, field, deps]);

  useLayoutEffect(
    () => () => {
      mirror.current?.dispose();
      mirror.current = null;
    },
    [],
  );

  return root && field ? view : null;
}
