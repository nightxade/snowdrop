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
});
