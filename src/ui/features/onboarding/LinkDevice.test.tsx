import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LinkDevice } from './LinkDevice';

afterEach(cleanup);

describe('LinkDevice', () => {
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
