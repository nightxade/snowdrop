import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionSetup } from './ConnectionSetup';

afterEach(cleanup);

describe('ConnectionSetup: not-installed (desktop, no signal-cli to run)', () => {
  it('explains the problem and takes a path once it looks valid', () => {
    const onProgramPath = vi.fn();
    render(
      <ConnectionSetup
        reason="not-installed"
        errorMessage="Snowdrop couldn’t start signal-cli."
        onProgramPath={onProgramPath}
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );

    expect(screen.getByRole('heading', { name: /signal-cli isn.t available/u })).toBeTruthy();
    expect(screen.getByText(/Snowdrop couldn.t start signal-cli\./u)).toBeTruthy();
    expect(screen.getByText(/Linux-native/u)).toBeTruthy();

    const input = screen.getByLabelText('Path to signal-cli');
    const submit = screen.getByRole('button', { name: 'Use it' });

    // A relative path is rejected, and nothing is reported upstream.
    act(() => {
      fireEvent.change(input, { target: { value: 'signal-cli' } });
      fireEvent.blur(input);
    });
    expect(screen.getByText('Enter the full path, starting with /.')).toBeTruthy();
    act(() => {
      fireEvent.click(submit);
    });
    expect(onProgramPath).not.toHaveBeenCalled();

    // An absolute path clears the error and is reported, trimmed.
    act(() => {
      fireEvent.change(input, { target: { value: '  /usr/local/bin/signal-cli  ' } });
    });
    expect(screen.queryByText('Enter the full path, starting with /.')).toBeNull();
    act(() => {
      fireEvent.click(submit);
    });
    expect(onProgramPath).toHaveBeenCalledWith('/usr/local/bin/signal-cli');
  });

  it('falls back to generic guidance with no error message', () => {
    render(
      <ConnectionSetup
        reason="not-installed"
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.getByText(/Snowdrop couldn.t find signal-cli\./u)).toBeTruthy();
  });
});

describe('ConnectionSetup: other reasons never show the missing-program screen', () => {
  it('shows the account prompt for "account-required"', () => {
    render(
      <ConnectionSetup
        reason="account-required"
        link={undefined}
        onLinked={() => undefined}
        onAccount={() => undefined}
        onBack={() => undefined}
      />,
    );
    expect(screen.queryByRole('heading', { name: /signal-cli isn.t available/u })).toBeNull();
  });
});
