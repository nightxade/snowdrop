import { describe, expect, it } from 'vitest';
import { BottomPin, PIN_SLACK_PX, slackFor } from './bottomPin';

describe('BottomPin (stick / followOutput rules)', () => {
  it('a list opened at the bottom holds it while rows settle', () => {
    const pin = new BottomPin();
    pin.reset(true);
    expect(pin.shouldRepin()).toBe(true);
  });

  it('a list opened at the unread divider or a jump target does not', () => {
    const pin = new BottomPin(true);
    pin.reset(false);
    expect(pin.shouldRepin()).toBe(false);
  });

  it('being scrolled up past the slack survives a new message and a row resize', () => {
    const pin = new BottomPin(true);
    pin.onScroll(PIN_SLACK_PX + 1);
    // A new message arrives / an image above finishes loading:
    expect(pin.shouldRepin()).toBe(false);
    expect(pin.isStuck).toBe(false);
    // …and the content growing (no scroll event) changes nothing.
    expect(pin.shouldRepin()).toBe(false);
  });

  it('a nudge within the slack keeps following', () => {
    const pin = new BottomPin(true);
    pin.onScroll(PIN_SLACK_PX - 30);
    expect(pin.shouldRepin()).toBe(true);
  });

  it('the slack boundary: at it the new message is followed, one px beyond it is not', () => {
    const at = new BottomPin(true);
    at.onScroll(PIN_SLACK_PX);
    expect(at.shouldRepin()).toBe(true);
    const beyond = new BottomPin(true);
    beyond.onScroll(PIN_SLACK_PX + 1);
    expect(beyond.shouldRepin()).toBe(false);
  });

  it('the slack is half the visible height, and never less than the minimum', () => {
    expect(slackFor(800)).toBe(400);
    expect(slackFor(100)).toBe(PIN_SLACK_PX);
  });

  it('a reader up to half a page away keeps following; past it, never moved', () => {
    const near = new BottomPin(true);
    near.setViewportHeight(800);
    near.onScroll(400);
    expect(near.shouldRepin()).toBe(true);
    const far = new BottomPin(true);
    far.setViewportHeight(800);
    far.onScroll(401);
    expect(far.shouldRepin()).toBe(false);
  });

  it('re-pins when the composer grows only if it was holding the bottom', () => {
    const stuck = new BottomPin(true);
    expect(stuck.shouldRepin()).toBe(true);
    const reading = new BottomPin(true);
    reading.onScroll(400);
    expect(reading.shouldRepin()).toBe(false);
  });

  it('sticks again once the reader returns to the bottom (or jumps there)', () => {
    const pin = new BottomPin(true);
    pin.onScroll(500);
    pin.onScroll(0);
    expect(pin.isStuck).toBe(true);
    pin.onScroll(500);
    pin.onReachedBottom();
    expect(pin.isStuck).toBe(true);
  });

  describe('following the newest message', () => {
    it("the list's own scrolling does not release the pin, however far the new row put the bottom", () => {
      const pin = new BottomPin(true);
      // A new message made the bottom 140px away; the smooth scroll to it fires events on the way.
      pin.beginFollow(1000);
      pin.onScroll(130, 1010);
      pin.onScroll(80, 1060);
      pin.onScroll(0, 1140);
      expect(pin.isStuck).toBe(true);
      // The next message is followed too.
      pin.beginFollow(1140);
      pin.onScroll(90, 1160);
      expect(pin.shouldRepin()).toBe(true);
    });

    it('the reader scrolling up during a follow takes the pin away', () => {
      const pin = new BottomPin(true);
      pin.beginFollow(1000);
      pin.onScroll(130, 1010);
      pin.onScroll(200, 900);
      expect(pin.isStuck).toBe(false);
      // …and the list does not follow again until they come back.
      expect(pin.shouldRepin()).toBe(false);
    });

    it('a long jump up right after a follow began still releases the pin', () => {
      const pin = new BottomPin(true);
      pin.beginFollow(1000);
      pin.onScroll(900, 100); // Home / Page Up: one event, far away
      expect(pin.isStuck).toBe(false);
    });

    it('a scroll with no position to compare keeps the old rule', () => {
      const pin = new BottomPin(true);
      pin.beginFollow();
      pin.onScroll(130, 1010);
      expect(pin.isStuck).toBe(false);
    });

    it('beginFollow holds the pin for a reader who had left, as a jump to the present does', () => {
      const pin = new BottomPin(true);
      pin.onScroll(400, 600);
      expect(pin.isStuck).toBe(false);
      pin.beginFollow(600);
      expect(pin.shouldRepin()).toBe(true);
    });

    it('outside a follow, scrolling away releases the pin even when moving down', () => {
      const pin = new BottomPin(true);
      pin.onScroll(100, 500);
      pin.onScroll(300, 600);
      expect(pin.isStuck).toBe(false);
    });
  });
});
