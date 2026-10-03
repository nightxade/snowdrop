/**
 * Boots a real Snowdrop on the demo backend (no latency, no liveliness) for
 * component tests, and renders UI inside the providers features expect.
 */
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createSnowdrop, type Snowdrop } from '@/app/createSnowdrop';
import { SnowdropProvider } from '@/app/SnowdropProvider';
import { createMemoryStorage } from '@/core/persistence';
import { TooltipProvider } from '@/ui/primitives';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export async function bootSnowdrop(): Promise<Snowdrop> {
  const snowdrop = createSnowdrop({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  snowdrop.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await act(async () => {
    await snowdrop.start();
    await snowdrop.sync.idle();
  });
  return snowdrop;
}

export function renderWithSnowdrop(snowdrop: Snowdrop, ui: ReactNode): RenderResult {
  return render(
    <SnowdropProvider snowdrop={snowdrop}>
      <TooltipProvider>{ui}</TooltipProvider>
    </SnowdropProvider>,
  );
}

/** Lets pending promises and store updates settle inside act(). */
export async function settle(snowdrop?: Snowdrop): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await snowdrop?.sync.idle();
    await new Promise((r) => setTimeout(r, 0));
  });
}
