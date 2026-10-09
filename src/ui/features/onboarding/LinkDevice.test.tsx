import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
