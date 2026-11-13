/**
 * Whether the message list should hold its bottom edge in place.
 *
 * "Stuck" means the user is reading the newest messages: then rows growing
 * (images, fonts, a reaction), the viewport shrinking (the composer grows,
 * a reply bar opens) or a new message must keep the bottom in view. The
 * moment the user scrolls away by more than a small slack it un-sticks, and
 * nothing may pull them back down until they return to the bottom
 * themselves (or jump there).
 *
 * Kept free of React and the virtualiser so the rules are unit-testable.
 */
export const PIN_SLACK_PX = 64;

export class BottomPin {
  private stuck: boolean;
  /**
   * The list is scrolling itself to the newest message (a smooth follow, a
   * re-pin, a jump): its own scroll events are far from the bottom until it
   * lands, and must not read as the user leaving.
   */
  private following = false;
  /** Where the previous scroll event left `scrollTop`, to tell moving down from moving up. */
  private lastTop: number | null = null;

  constructor(initiallyStuck = false) {
    this.stuck = initiallyStuck;
  }

  get isStuck(): boolean {
    return this.stuck;
  }

  /** A (re)mounted list starting at the bottom starts stuck; one opened at a divider or jump target doesn't. */
  reset(stuck: boolean): void {
    this.stuck = stuck;
    this.following = false;
    this.lastTop = null;
  }

  /**
   * Every scroll, user or programmatic: distance from the bottom edge in px,
   * and `scrollTop` when known. While the list is following the newest
   * message, a scroll that is not upwards is its own animation (it starts
   * further than the slack from the new bottom); only the reader moving up
   * takes the pin away. Outside a follow (or with no position to compare
   * to) any scroll beyond the slack does.
   */
  onScroll(distanceFromBottom: number, scrollTop?: number): void {
    const movedUp = scrollTop !== undefined && (this.lastTop === null || scrollTop < this.lastTop);
    if (scrollTop !== undefined) this.lastTop = scrollTop;
    if (distanceFromBottom <= 1) {
      this.stuck = true;
      this.following = false;
    } else if (distanceFromBottom > PIN_SLACK_PX && (!this.following || movedUp)) {
      this.stuck = false;
      this.following = false;
    }
  }

  /** The virtualiser reached the bottom (e.g. after a jump to present). */
  onReachedBottom(): void {
    this.stuck = true;
    this.following = false;
  }

  /**
   * The list is about to scroll itself to the bottom (see `following`); it also holds the pin.
   * `scrollTop` is where it stands now, so the first scroll of the follow can be told from the reader moving up.
   */
  beginFollow(scrollTop?: number): void {
    this.stuck = true;
    this.following = true;
    if (scrollTop !== undefined) this.lastTop = scrollTop;
  }

  /**
   * Content height or viewport height changed (rows measured, composer
   * resized, message appended). Returns whether to scroll back to the bottom.
   */
  shouldRepin(): boolean {
    return this.stuck;
  }
}
