import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AreaErrorBoundary } from './AreaErrorBoundary';

// React's own default logging for a caught error is not what is under test.
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const control = { broken: true };

function Maybe() {
  if (control.broken) throw new Error('boom');
  return <p>fine now</p>;
}

describe('AreaErrorBoundary', () => {
  it('shows a compact alert in place and leaves its siblings alone', () => {
    control.broken = true;
    render(
      <div>
        <p>sibling</p>
        <AreaErrorBoundary area="the chat" report={() => undefined}>
          <Maybe />
        </AreaErrorBoundary>
      </div>,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Something went wrong showing the chat.',
    );
    expect(screen.getByText('sibling')).toBeTruthy();
  });

  it('reports a caught error exactly once, and not again on re-renders', () => {
    control.broken = true;
    const report = vi.fn();
    const view = render(
      <AreaErrorBoundary area="the chat" report={report}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    view.rerender(
      <AreaErrorBoundary area="the chat" report={report}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('Try again re-renders the children', () => {
    control.broken = true;
    render(
      <AreaErrorBoundary area="the chat" report={() => undefined}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    control.broken = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(screen.getByText('fine now')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('resets by itself when a reset key changes', () => {
    control.broken = true;
    function Host() {
      const [id, setId] = useState('a');
      return (
        <>
          <button
            type="button"
            onClick={() => {
              setId('b');
            }}
          >
            next
          </button>
          <AreaErrorBoundary area="the chat" resetKeys={[id]} report={() => undefined}>
            <Maybe />
          </AreaErrorBoundary>
        </>
      );
    }
    render(<Host />);
    expect(screen.getByRole('alert')).toBeTruthy();
    control.broken = false;
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'next' }));
    });
    expect(screen.getByText('fine now')).toBeTruthy();
  });

  it('stays in the fallback when the reset keys are unchanged', () => {
    control.broken = true;
    const view = render(
      <AreaErrorBoundary area="the chat" resetKeys={['a']} report={() => undefined}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    control.broken = false;
    view.rerender(
      <AreaErrorBoundary area="the chat" resetKeys={['a']} report={() => undefined}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    expect(screen.getByRole('alert')).toBeTruthy();
  });

  it('with onClose the fallback is a dialog that can be dismissed', () => {
    control.broken = true;
    const onClose = vi.fn();
    render(
      <AreaErrorBoundary area="this dialog" onClose={onClose} report={() => undefined}>
        <Maybe />
      </AreaErrorBoundary>,
    );
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });
});
