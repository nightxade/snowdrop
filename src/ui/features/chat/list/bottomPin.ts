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

  constructor(initiallyStuck = false) {
    this.stuck = initiallyStuck;
  }

  get isStuck(): boolean {
    return this.stuck;
  }

  /** A (re)mounted list starting at the bottom starts stuck; one opened at a divider or jump target doesn't. */
  reset(stuck: boolean): void {
    this.stuck = stuck;
  }

  /** Every scroll, user or programmatic: distance from the bottom edge in px. */
  onScroll(distanceFromBottom: number): void {
    if (distanceFromBottom > PIN_SLACK_PX) this.stuck = false;
    else if (distanceFromBottom <= 1) this.stuck = true;
  }

  /** The virtualiser reached the bottom (e.g. after a jump to present). */
  onReachedBottom(): void {
    this.stuck = true;
  }

  /**
   * Content height or viewport height changed (rows measured, composer
   * resized, message appended). Returns whether to scroll back to the bottom.
   */
  shouldRepin(): boolean {
    return this.stuck;
  }
}
