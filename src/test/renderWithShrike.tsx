/**
 * Boots a real Shrike on the demo backend (no latency, no liveliness) for
 * component tests, and renders UI inside the providers features expect.
 */
import { act, render, type RenderResult } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createShrike, type Shrike } from '@/app/createShrike';
import { ShrikeProvider } from '@/app/ShrikeProvider';
import { createMemoryStorage } from '@/core/persistence';
import { TooltipProvider } from '@/ui/primitives';

// Tell React this environment supports act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

export async function bootShrike(): Promise<Shrike> {
  const shrike = createShrike({ storage: createMemoryStorage(), mockLatencyMs: 0 });
  shrike.stores.settings
    .getState()
    .update('connection', { backend: 'mock', mockLiveliness: false });
  await act(async () => {
    await shrike.start();
    await shrike.sync.idle();
  });
  return shrike;
}

export function renderWithShrike(shrike: Shrike, ui: ReactNode): RenderResult {
  return render(
    <ShrikeProvider shrike={shrike}>
      <TooltipProvider>{ui}</TooltipProvider>
    </ShrikeProvider>,
  );
}

/** Lets pending promises and store updates settle inside act(). */
export async function settle(shrike?: Shrike): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await shrike?.sync.idle();
    await new Promise((r) => setTimeout(r, 0));
  });
}
