import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Welcome } from './Welcome';

afterEach(cleanup);

describe('Welcome (desktop)', () => {
  it('leads with "Use your Signal account" as the primary, focused choice', () => {
    const onConnect = vi.fn();
    render(
      <Welcome
        desktop
        defaultDaemonUrl="/signal-cli"
        onDemo={() => undefined}
        onConnect={onConnect}
      />,
    );
    const choice = screen.getByRole('button', { name: /Use your Signal account/u });
    expect(choice.textContent).toContain('Link this computer to your phone with a QR code');
    expect(screen.queryByText(/signal-cli daemon running on this computer/u)).toBeNull();

    // It's first in DOM/tab order, and holds initial focus.
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toBe(choice);
    expect(document.activeElement).toBe(choice);

    act(() => {
      fireEvent.click(choice);
    });

    // No intermediate step: connecting is called immediately, with the stored default.
    expect(onConnect).toHaveBeenCalledWith('/signal-cli');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('demotes the demo to a small secondary link below the primary choice', () => {
    const onDemo = vi.fn();
    render(
      <Welcome
        desktop
        defaultDaemonUrl="/signal-cli"
        onDemo={onDemo}
        onConnect={() => undefined}
      />,
    );
    const demo = screen.getByRole('button', { name: /Not ready to link\? Try the demo first/u });
    expect(screen.getByText(/Nothing is sent anywhere\./u)).toBeTruthy();

    // It comes after the primary choice in the DOM.
    const buttons = screen.getAllByRole('button');
    expect(buttons.indexOf(demo)).toBeGreaterThan(0);

    act(() => {
      fireEvent.click(demo);
    });
    expect(onDemo).toHaveBeenCalledTimes(1);
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

    // Still the primary, first and focused choice.
    const buttons = screen.getAllByRole('button');
    expect(buttons[0]).toBe(choice);
    expect(document.activeElement).toBe(choice);

    act(() => {
      fireEvent.click(choice);
    });

    // The desktop-only copy and icon are gone; the browser gets the daemon-URL form instead.
    expect(onConnect).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Use your Signal account/u })).toBeNull();
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
