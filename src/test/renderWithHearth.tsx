/**
 * Boots a real Hearth on the demo backend (no latency, no liveliness) for
 * component tests, and renders UI inside the providers features expect.
 */
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createHearth, type Hearth } from '@/app/createHearth';
import { HearthProvider } from '@/app/HearthProvider';
import { createMemoryStorage } from '@/core/persistence';
import { TooltipProvider } from '@/ui/primitives';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export async function bootHearth(): Promise<Hearth> {
  const hearth = createHearth({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  hearth.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await act(async () => {
    await hearth.start();
    await hearth.sync.idle();
  });
  return hearth;
}

export function renderWithHearth(hearth: Hearth, ui: ReactNode): RenderResult {
  return render(
    <HearthProvider hearth={hearth}>
      <TooltipProvider>{ui}</TooltipProvider>
    </HearthProvider>,
  );
}

/** Lets pending promises and store updates settle inside act(). */
export async function settle(hearth?: Hearth): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await hearth?.sync.idle();
    await new Promise((r) => setTimeout(r, 0));
  });
}
