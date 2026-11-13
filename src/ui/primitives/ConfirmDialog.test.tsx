import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

afterEach(cleanup);

function deferred() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('ConfirmDialog', () => {
  it('focuses Cancel for a dangerous action and the action otherwise', async () => {
    render(
      <ConfirmDialog title="Delete" confirmLabel="Delete" danger run={vi.fn()} onClose={vi.fn()} />,
    );
    await act(() => Promise.resolve());
    expect(document.activeElement?.textContent).toBe('Cancel');
    cleanup();
    render(<ConfirmDialog title="Save" confirmLabel="Save" run={vi.fn()} onClose={vi.fn()} />);
    await act(() => Promise.resolve());
    expect(document.activeElement?.textContent).toBe('Save');
  });

  it('shows it is working, can’t be dismissed meanwhile, and closes once done', async () => {
    const user = userEvent.setup();
    const pending = deferred();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Leave"
        confirmLabel="Leave"
        busyLabel="Leaving…"
        run={() => pending.promise}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByRole('button', { name: 'Leaving…' }).getAttribute('aria-busy')).toBe('true');
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => {
      pending.resolve(null);
      await pending.promise;
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a refusal on screen and stays open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <ConfirmDialog
        title="Remove"
        confirmLabel="Remove"
        run={() => Promise.resolve('Only admins can do that.')}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.getByRole('alert').textContent).toBe('Only admins can do that.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
