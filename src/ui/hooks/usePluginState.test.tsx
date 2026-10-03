import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createPluginState } from '@/core/plugins/state';
import { usePluginState } from './usePluginState';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('usePluginState', () => {
  it('renders the current value and follows changes', () => {
    const state = createPluginState('here', () => undefined);
    function Status() {
      return <span data-testid="s">{usePluginState(state)}</span>;
    }
    render(<Status />);
    expect(screen.getByTestId('s').textContent).toBe('here');
    act(() => {
      state.set('away');
    });
    expect(screen.getByTestId('s').textContent).toBe('away');
  });
});
