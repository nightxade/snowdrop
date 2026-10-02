import { describe, expect, it } from 'vitest';
import { BottomPin, PIN_SLACK_PX } from './bottomPin';

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

  it('being scrolled up 120px survives a new message and a row resize', () => {
    const pin = new BottomPin(true);
    pin.onScroll(120);
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
});
