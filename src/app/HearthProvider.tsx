import { createContext, use, type ReactNode } from 'react';
import { HearthContextProvider } from '@/ui/hooks';
import type { Hearth } from './createHearth';

const HearthContext = createContext<Hearth | null>(null);

/**
 * Makes the composed app available to the React tree: the full `Hearth` for
 * app/ code, and the `AppServices` view of it for ui/ features.
 */
export function HearthProvider({ hearth, children }: { hearth: Hearth; children: ReactNode }) {
  return (
    <HearthContext value={hearth}>
      <HearthContextProvider value={hearth}>{children}</HearthContextProvider>
    </HearthContext>
  );
}

export function useHearth(): Hearth {
  const hearth = use(HearthContext);
  if (!hearth) throw new Error('useHearth must be used inside <HearthProvider>');
  return hearth;
}
