/**
 * Measures text positions inside a textarea with a hidden "mirror": a div
 * that copies the field's font, padding, width and wrapping, holds the same
 * text, and wraps the measured range in a span whose box is read back. The
 * usual technique for caret coordinates in a textarea (which exposes none).
 */
import type { CaretMeasure, MeasuredBox } from './caretCell';

/** Computed properties that change how text lays out. */
const COPIED = [
  'boxSizing',
  'direction',
  'fontFamily',
  'fontFeatureSettings',
  'fontKerning',
  'fontSize',
  'fontSizeAdjust',
  'fontStretch',
  'fontStyle',
  'fontVariant',
  'fontVariationSettings',
  'fontWeight',
  'letterSpacing',
  'lineHeight',
  'paddingBottom',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'tabSize',
  'textAlign',
  'textIndent',
  'textTransform',
  'wordSpacing',
] as const;

/** Zero-width marker for an empty cell (end of line, empty field). */
const MARKER = '​';

export interface Mirror {
  /** A fresh measurer for the field's current style and width. */
  measure(field: HTMLTextAreaElement): CaretMeasure;
  dispose(): void;
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** Numeric line height in px ("normal" falls back to 1.2em). */
function lineHeightOf(style: CSSStyleDeclaration): number {
  const lh = px(style.lineHeight);
  return lh > 0 ? lh : px(style.fontSize) * 1.2;
}

export function createMirror(doc: Document = document): Mirror {
  let div: HTMLDivElement | null = null;

  const ensure = (): HTMLDivElement => {
    if (div?.isConnected) return div;
    div = doc.createElement('div');
    div.setAttribute('aria-hidden', 'true');
    div.dataset.vimCaretMirror = '';
    Object.assign(div.style, {
      position: 'absolute',
      top: '0',
      left: '-9999px',
      visibility: 'hidden',
      pointerEvents: 'none',
      overflow: 'hidden',
      border: '0',
      margin: '0',
      height: 'auto',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      wordBreak: 'normal',
    } satisfies Partial<CSSStyleDeclaration>);
    doc.body.appendChild(div);
    return div;
  };

  return {
    measure(field) {
      const mirror = ensure();
      const style = getComputedStyle(field);
      for (const prop of COPIED) mirror.style[prop] = style[prop];
      const padLeft = px(style.paddingLeft);
      const padRight = px(style.paddingRight);
      // clientWidth excludes the border and a vertical scrollbar: the width text wraps in.
      mirror.style.boxSizing = 'content-box';
      mirror.style.width = `${Math.max(0, field.clientWidth - padLeft - padRight)}px`;
      const lineHeight = lineHeightOf(style);
      const paddingTop = px(style.paddingTop);
      // Rects are in viewport px, offsets in layout px: they differ under CSS zoom/scale.
      const rect = mirror.getBoundingClientRect().width;
      const scale = mirror.offsetWidth > 0 && rect > 0 ? rect / mirror.offsetWidth : 1;

      const box = (text: string, start: number, end: number): MeasuredBox => {
        const span = doc.createElement('span');
        span.textContent = end > start ? text.slice(start, end) : MARKER;
        // The rest of the text keeps wrapping identical (a word isn't split differently).
        mirror.replaceChildren(
          doc.createTextNode(text.slice(0, start)),
          span,
          doc.createTextNode(text.slice(end)),
        );
        return {
          left: span.offsetLeft,
          top: span.offsetTop,
          width: end > start ? span.getBoundingClientRect().width / scale : 0,
          height: span.offsetHeight,
        };
      };

      // 1ch: the width of "0", the conventional average character cell.
      const zero = box('0', 0, 1);
      return { box, lineHeight, paddingTop, cellWidth: zero.width || px(style.fontSize) * 0.55 };
    },
    dispose() {
      div?.remove();
      div = null;
    },
  };
}
