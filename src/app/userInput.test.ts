import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '@/core/lib';
import { trackUserInput } from './userInput';

describe('trackUserInput', () => {
  it('knows whether a key or a pointer press came after a moment, and nothing else counts', () => {
    const clock = new ManualScheduler(1000);
    const input = trackUserInput(clock, window);
    expect(input.since(0)).toBe(false);
    clock.advance(5);
    window.dispatchEvent(new Event('pointermove'));
    window.dispatchEvent(new Event('keyup'));
    expect(input.since(1000)).toBe(false);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(input.since(1000)).toBe(true);
    // At the same instant is not after: the Enter that sent the message is not input since it.
    expect(input.since(1005)).toBe(false);
    clock.advance(5);
    window.dispatchEvent(new Event('pointerdown'));
    expect(input.since(1005)).toBe(true);
    input.stop();
    clock.advance(5);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b' }));
    expect(input.since(1010)).toBe(false);
  });
});
