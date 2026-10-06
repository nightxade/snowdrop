/**
 * There was no error boundary before this: a render error anywhere blanked
 * the whole window. In the style of Slot's PluginBoundary test
 * (src/ui/primitives/primitives.test.tsx) — `console.error` is stubbed so
 * React's own default logging for a caught error doesn't spam the test
 * output; it isn't what's under test here.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@/core/lib';
import { AppErrorBoundary } from './AppErrorBoundary';

afterEach(cleanup);

function Boom(): never {
  throw new Error('boom');
}

describe('AppErrorBoundary', () => {
  it('renders the fallback when a child throws', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy();
    expect(screen.getByText(/your data is safe/iu)).toBeTruthy();
    error.mockRestore();
  });

  it('moves focus to the heading', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Something went wrong' }),
    );
    error.mockRestore();
  });

  it('calls location.reload when Reload is clicked', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
    reload.mockRestore();
    error.mockRestore();
  });

  it('copies the error details to the clipboard, with a quiet confirmation', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toContain('boom');
    expect(screen.getByRole('status').textContent).toContain('Copied');
    error.mockRestore();
  });

  it('appends the recent log tail to the copied details, best effort', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    createLogger('app-error-boundary-test').error('a marker line for this test');
    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy details' }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0]?.[0] as string;
    expect(text).toContain('--- recent log ---');
    expect(text).toContain('a marker line for this test');
    error.mockRestore();
  });

  it('reports the error exactly once, via the given report function', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const report = vi.fn();
    render(
      <AppErrorBoundary report={report}>
        <Boom />
      </AppErrorBoundary>,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(report.mock.calls[0]?.[1]).toContain('caught render error');
    error.mockRestore();
  });
});
