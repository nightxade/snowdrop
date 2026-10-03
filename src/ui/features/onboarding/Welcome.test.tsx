import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Welcome } from './Welcome';

afterEach(cleanup);

describe('Welcome (desktop)', () => {
  it('goes straight to device linking, with no daemon-URL form', () => {
    const onConnect = vi.fn();
    render(
      <Welcome desktop defaultDaemonUrl="/signal-cli" onDemo={() => undefined} onConnect={onConnect} />,
    );
    const choice = screen.getByRole('button', { name: /Use your Signal account/u });
    expect(choice.textContent).toContain('Link this computer to your phone with a QR code');
    expect(screen.queryByText(/signal-cli daemon running on this computer/u)).toBeNull();

    act(() => {
      fireEvent.click(choice);
    });

    // No intermediate step: connecting is called immediately, with the stored default.
    expect(onConnect).toHaveBeenCalledWith('/signal-cli');
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

describe('Welcome (browser)', () => {
  it('asks for a daemon URL instead of linking a device', () => {
    const onConnect = vi.fn();
    render(
      <Welcome defaultDaemonUrl="/signal-cli" onDemo={() => undefined} onConnect={onConnect} />,
    );
    const choice = screen.getByRole('button', { name: /Connect to signal-cli/u });
    expect(choice.textContent).toContain('signal-cli daemon running on this computer');

    act(() => {
      fireEvent.click(choice);
    });

    // The desktop-only copy and icon are gone; the browser gets the daemon-URL form instead.
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Use your Signal account/u })).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
