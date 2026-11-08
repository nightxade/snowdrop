import { act, cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeybindRecorder } from './KeybindRecorder';

afterEach(cleanup);

function recording() {
  const onRecord = vi.fn();
  render(<KeybindRecorder value="" onRecord={onRecord} label="Search" />);
  const button = screen.getByRole('button');
  act(() => {
    fireEvent.click(button);
  });
  return { button, onRecord };
}

describe('KeybindRecorder', () => {
  it('lets Tab move focus on, ending the recording without a binding', () => {
    const { button, onRecord } = recording();
    const tab = createEvent.keyDown(button, { key: 'Tab' });
    act(() => {
      fireEvent(button, tab);
    });
    expect(tab.defaultPrevented).toBe(false);
    expect(button.hasAttribute('data-recording')).toBe(false);
    expect(onRecord).not.toHaveBeenCalled();
  });

  it('still swallows Escape and real shortcuts', () => {
    const { button } = recording();
    const escape = createEvent.keyDown(button, { key: 'Escape' });
    act(() => {
      fireEvent(button, escape);
    });
    expect(escape.defaultPrevented).toBe(true);
  });
});
