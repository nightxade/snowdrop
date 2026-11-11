import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '@/core/lib';
import { LinkDevice } from './LinkDevice';

afterEach(cleanup);

describe('LinkDevice', () => {
  it('keeps a history warning visible until continuing with the linked account', async () => {
    const onLinked = vi.fn();
    const link = {
      start: vi.fn().mockResolvedValue({ uri: 'sgnl://linkdevice?uuid=test' }),
      finish: vi
        .fn()
        .mockResolvedValue({ accountId: 'account', historyWarning: 'History import failed.' }),
    };
    render(<LinkDevice link={link} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect((await screen.findByRole('alert')).textContent).toBe('History import failed.');
    expect(screen.getByRole('heading', { name: 'Snowdrop is linked' })).toBeTruthy();
    expect(screen.queryByText(/has no account yet/)).toBeNull();
    expect(screen.queryByText('Open Signal on your phone.')).toBeNull();
    expect(onLinked).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Continue to conversations' }));
    expect(onLinked).toHaveBeenCalledWith('account');
    expect(link.start).toHaveBeenCalledTimes(1);
  });

  it('says "tab" in the browser', () => {
    render(<LinkDevice link={undefined} onLinked={() => undefined} />);
    expect(screen.getByText(/Keep this tab open until it finishes\./u)).toBeTruthy();
  });

  it('says "window" in the desktop app', () => {
    render(<LinkDevice link={undefined} onLinked={() => undefined} desktop />);
    expect(screen.getByText(/Keep this window open until it finishes\./u)).toBeTruthy();
    expect(screen.queryByText(/Keep this tab open/u)).toBeNull();
  });

  it('defaults the device name to plain "Snowdrop" in the desktop app', () => {
    render(<LinkDevice link={undefined} onLinked={() => undefined} desktop />);
    const input = screen.getByLabelText('Device name');
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect((input as HTMLInputElement).value).toBe('Snowdrop');
  });

  it('does not report a link that finishes after the screen was left', async () => {
    const onLinked = vi.fn();
    let finish!: (value: { accountId: string }) => void;
    const link = {
      start: vi.fn().mockResolvedValue({ uri: 'sgnl://linkdevice?uuid=test' }),
      finish: vi.fn(
        () =>
          new Promise<{ accountId: string }>((resolve) => {
            finish = resolve;
          }),
      ),
    };
    const { unmount } = render(<LinkDevice link={link} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    await vi.waitFor(() => {
      expect(link.finish).toHaveBeenCalledTimes(1);
    });
    unmount();
    await act(async () => {
      finish({ accountId: 'account' });
      await Promise.resolve();
    });
    expect(onLinked).not.toHaveBeenCalled();
  });

  /** A link whose `finish` waits until its signal fires, then rejects the way an adapter does. */
  function abortableLink() {
    const signals: AbortSignal[] = [];
    const link = {
      start: vi.fn().mockResolvedValue({ uri: 'sgnl://linkdevice?uuid=test' }),
      finish: vi.fn(
        (_uri: string, _name: string, options?: { signal?: AbortSignal }) =>
          new Promise<{ accountId: string }>((_resolve, reject) => {
            const signal = options?.signal;
            if (signal) signals.push(signal);
            signal?.addEventListener('abort', () => {
              reject(new AppError('aborted', 'Request aborted', { outcome: 'maybe-sent' }));
            });
          }),
      ),
    };
    return { link, signals };
  }

  it('aborts the link in flight when the screen is left, and shows no error', async () => {
    const onLinked = vi.fn();
    const { link, signals } = abortableLink();
    const { unmount, container } = render(<LinkDevice link={link} onLinked={onLinked} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    await vi.waitFor(() => {
      expect(link.finish).toHaveBeenCalledTimes(1);
    });
    expect(signals[0]?.aborted).toBe(false);
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(container.textContent).toBe('');
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('aborts the link when the user goes back to edit, without showing a failure', async () => {
    const { link, signals } = abortableLink();
    render(<LinkDevice link={link} onLinked={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    await vi.waitFor(() => {
      expect(link.finish).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change name' }));
    expect(signals[0]?.aborted).toBe(true);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Device name')).toBeTruthy();
  });

  it('still reports a link that finishes while the screen is up (StrictMode safe)', async () => {
    const onLinked = vi.fn();
    const link = {
      start: vi.fn().mockResolvedValue({ uri: 'sgnl://linkdevice?uuid=test' }),
      finish: vi.fn().mockResolvedValue({ accountId: 'account' }),
    };
    render(
      <StrictMode>
        <LinkDevice link={link} onLinked={onLinked} />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    await vi.waitFor(() => {
      expect(onLinked).toHaveBeenCalledWith('account');
    });
    expect(link.start).toHaveBeenCalledTimes(1);
  });
});
