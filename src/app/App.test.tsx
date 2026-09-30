import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { createMemoryStorage } from '@/core/persistence';
import { App } from './App';
import { createHearth } from './createHearth';
import { HearthProvider } from './HearthProvider';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('<App />', () => {
  it('renders the placeholder and reflects the synced store', async () => {
    const hearth = createHearth({ storage: createMemoryStorage(), mockLatencyMs: 0 });
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
      root.render(
        <HearthProvider hearth={hearth}>
          <App />
        </HearthProvider>,
      );
    });
    expect(container.textContent).toContain('Hearth — foundation ready');
    expect(container.textContent).toContain('Connecting…');

    await act(() => hearth.start());
    expect(container.textContent).toContain('22 conversations');
    expect(container.textContent).toContain('online');

    act(() => {
      root.unmount();
    });
    await hearth.dispose();
  });
});
