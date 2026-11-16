import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useShiftHeld } from './useShiftHeld';

function Probe() {
  return <span data-testid="shift">{useShiftHeld() ? 'held' : 'up'}</span>;
}

const state = () => document.querySelector('[data-testid="shift"]')?.textContent;

afterEach(cleanup);

describe('useShiftHeld', () => {
  it('follows Shift down and up', () => {
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    });
    expect(state()).toBe('held');
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', shiftKey: false }));
    });
    expect(state()).toBe('up');
  });

  it('a bar mounted while Shift stays down learns it from the next pointer move', () => {
    const first = render(<Probe />);
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', shiftKey: true }));
    });
    // Shift+click deleted the row: its bar unmounts, the next row's mounts. No key event follows.
    first.unmount();
    render(<Probe />);
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { shiftKey: true }));
    });
    expect(state()).toBe('held');
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { shiftKey: false }));
    });
    expect(state()).toBe('up');
  });
});
