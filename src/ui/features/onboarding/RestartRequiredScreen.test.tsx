import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import { RestartRequiredScreen } from './RestartRequiredScreen';

afterEach(cleanup);

describe('RestartRequiredScreen', () => {
  it('stays busy while the restart is under way', () => {
    const onRestart = vi.fn(() => new Promise<void>(() => undefined));
    render(<RestartRequiredScreen onRestart={onRestart} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart Snowdrop' }));
    });
    expect(onRestart).toHaveBeenCalledTimes(1);
    // Inert: `disabled`, or `aria-disabled` while it still has focus (a focused button keeps it).
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Restart Snowdrop' });
    expect(button.disabled || button.getAttribute('aria-disabled') === 'true').toBe(true);
  });

  it('shows why a failed restart failed and lets the user try again', async () => {
    const onRestart = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('IPC timed out'))
      .mockResolvedValue(undefined);
    render(<RestartRequiredScreen onRestart={onRestart} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Restart Snowdrop' }));
      await Promise.resolve();
    });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('IPC timed out');
    expect(alert.textContent).toContain('Close it and open it again');
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Restart Snowdrop' });
    expect(button.disabled).toBe(false);
    expect((await axe(document.body)).violations).toEqual([]);
    await act(async () => {
      fireEvent.click(button);
      await Promise.resolve();
    });
    expect(onRestart).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
