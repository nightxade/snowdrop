import { createContext, use, type ReactNode } from 'react';
import type { Hearth } from './createHearth';

const HearthContext = createContext<Hearth | null>(null);

/** Makes the composed app (stores, services, registries) available to the React tree. */
export function HearthProvider({ hearth, children }: { hearth: Hearth; children: ReactNode }) {
  return <HearthContext value={hearth}>{children}</HearthContext>;
}

export function useHearth(): Hearth {
  const hearth = use(HearthContext);
  if (!hearth) throw new Error('useHearth must be used inside <HearthProvider>');
  return hearth;
}
