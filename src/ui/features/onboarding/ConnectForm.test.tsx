import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/ui/primitives';
import { ConnectForm } from './ConnectForm';

afterEach(cleanup);

describe('ConnectForm', () => {
  it('reports a probe that rejects instead of staying on "Checking…"', async () => {
    const onConnect = vi.fn();
    render(
      <TooltipProvider>
        <ConnectForm
          defaultUrl="/signal-cli"
          onConnect={onConnect}
          probe={() => Promise.reject(new Error('chunk failed to load'))}
        />
      </TooltipProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
      await Promise.resolve();
    });
    expect((await screen.findByRole('alert')).textContent).toContain('chunk failed to load');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect' }).disabled).toBe(false);
    expect(onConnect).not.toHaveBeenCalled();
  });
});
