/** Boots the real app on the demo backend for integration tests. */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { App, createHearth, HearthProvider, type Hearth } from '@/app';
import { createMemoryStorage } from '@/core/persistence';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export const live: Hearth[] = [];

export async function disposeAll(): Promise<void> {
  for (const h of live.splice(0)) await h.dispose();
}

/** Makes `matchMedia` report the given layout (breakpoints from PLAN §4.1). */
export function setViewport(width: number): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      const max = /max-width:\s*([\d.]+)px/u.exec(query);
      const matches = max ? width <= Number(max[1]) : false;
      return {
        matches,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      };
    },
  });
}

export async function bootDemo(): Promise<Hearth> {
  const hearth = createHearth({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  live.push(hearth);
  hearth.stores.settings.getState().update('connection', { mockLiveliness: false });
  render(
    <HearthProvider hearth={hearth}>
      <App />
    </HearthProvider>,
  );
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /Try the demo/u }));
    await Promise.resolve();
  });
  await act(async () => {
    await hearth.start();
    await hearth.sync.idle();
  });
  return hearth;
}

export function key(
  init: KeyboardEventInit,
  target: EventTarget = document.activeElement ?? window,
) {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** Lets Radix's deferred focus handling (setTimeout/rAF) run. */
export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}
