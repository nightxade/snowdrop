/**
 * Keeps the message a reader is looking at where it is while rows above it change size (a
 * reaction under an older message, a longer edit, a delete, the "no more history" intro replacing
 * its skeleton).
 *
 * The virtualiser compensates for such changes only while the reader is scrolling up (its upward
 * compensation stops 50 ms after the last scroll event), and a row that grows above an idle reader
 * pushes everything below it down. This remembers the first message that starts in view and how
 * far below the scroller's top it sits, and says how far to scroll to put it back.
 *
 * What it remembers is taken once the list has been still for `SCROLLING_MS`, not at a scroll
 * event: right after a jump the rows on screen are not yet the ones the virtualiser will place there.
 *
 * Kept free of React and the virtualiser so the rules are unit-testable.
 */

/**
 * A scroll event this recent means the reader (or the list's own animation) is moving the list,
 * and the virtualiser looks after the rows it measures meanwhile.
 */
export const SCROLLING_MS = 100;

const MESSAGE = '[data-message-id]';

export class ReadingAnchor {
  private id: string | null = null;
  private offset = 0;
  /** `firstItemIndex` when the anchor was taken: it changes when older history is prepended. */
  private firstItemIndex = 0;
  private scrolledAt = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The `scrollTop` `hold` set: the scroll event it causes is the anchor's own, not the reader's. */
  private heldTop: number | null = null;

  constructor(private readonly now: () => number = () => performance.now()) {}

  /** The list scrolled (any scroll: the reader's or the list's own). */
  noteScroll(scroller: HTMLElement, firstItemIndex: number): void {
    if (this.heldTop !== null && scroller.scrollTop === this.heldTop) return;
    this.heldTop = null;
    this.scrolledAt = this.now();
    this.rebaseSoon(scroller, firstItemIndex);
  }

  /** Takes the first message in view as the anchor once the list has been left alone for a moment. */
  rebaseSoon(scroller: HTMLElement, firstItemIndex: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.rebase(scroller, firstItemIndex);
    }, SCROLLING_MS);
  }

  /** Stops a pending `rebaseSoon` (the list went away). */
  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private rebase(scroller: HTMLElement, firstItemIndex: number): void {
    const top = scroller.getBoundingClientRect().top;
    this.firstItemIndex = firstItemIndex;
    // The first message that starts in view: one cut off by the top edge is above the reader, and
    // growing (a reaction) or shrinking moves what they are reading. A message so tall that none
    // starts in view is the anchor itself.
    let inView: { el: HTMLElement; top: number } | undefined;
    for (const el of scroller.querySelectorAll<HTMLElement>(MESSAGE)) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= top) continue;
      inView ??= { el, top: rect.top };
      if (rect.top >= top) {
        inView = { el, top: rect.top };
        break;
      }
    }
    this.id = inView?.el.dataset.messageId ?? null;
    this.offset = inView ? inView.top - top : 0;
  }

  /**
   * How far (px, down is positive) the list must scroll to put the anchor back where it was; 0
   * when it has not moved, is no longer rendered, the list is being scrolled, or older history was
   * just prepended (the virtualiser keeps the view then). In each of those cases the anchor is
   * taken afresh, once the list is still.
   */
  drift(scroller: HTMLElement, firstItemIndex: number): number {
    const anchor = this.id;
    if (
      anchor === null ||
      firstItemIndex !== this.firstItemIndex ||
      this.now() - this.scrolledAt < SCROLLING_MS
    ) {
      this.rebaseSoon(scroller, firstItemIndex);
      return 0;
    }
    const top = scroller.getBoundingClientRect().top;
    for (const el of scroller.querySelectorAll<HTMLElement>(MESSAGE)) {
      if (el.dataset.messageId !== anchor) continue;
      return el.getBoundingClientRect().top - top - this.offset;
    }
    this.rebaseSoon(scroller, firstItemIndex);
    return 0;
  }

  /** Scrolls the list by `drift`: the anchor is back where the reader had it. */
  hold(scroller: HTMLElement, firstItemIndex: number): void {
    const drift = this.drift(scroller, firstItemIndex);
    if (drift === 0) return;
    scroller.scrollTop += drift;
    this.heldTop = scroller.scrollTop;
  }
}
