import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StorageUnavailable } from './StorageUnavailable';

afterEach(cleanup);

describe('StorageUnavailable', () => {
  it('explains another running instance', () => {
    render(<StorageUnavailable reason="alreadyRunning" onRetry={() => Promise.resolve()} />);
    expect(screen.getByRole('heading', { name: /Snowdrop is already open/u })).toBeTruthy();
  });

  it('explains a missing RAM-backed directory', () => {
    render(<StorageUnavailable reason="noRamDir" onRetry={() => Promise.resolve()} />);
    expect(screen.getByRole('heading', { name: /No RAM-backed storage/u })).toBeTruthy();
  });

  it('retries on demand', () => {
    const onRetry = vi.fn().mockResolvedValue(undefined);
    render(<StorageUnavailable reason="alreadyRunning" onRetry={onRetry} />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('shows the error, and re-enables the button, when the retry rejects', async () => {
    const onRetry = vi.fn().mockRejectedValue(new Error('status check failed'));
    render(<StorageUnavailable reason="alreadyRunning" onRetry={onRetry} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('status check failed');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Try again' }).disabled).toBe(
      false,
    );
  });
});
