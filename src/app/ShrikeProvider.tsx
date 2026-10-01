import { createContext, use, type ReactNode } from 'react';
import { ShrikeContextProvider } from '@/ui/hooks';
import type { Shrike } from './createShrike';

const ShrikeContext = createContext<Shrike | null>(null);

/**
 * Makes the composed app available to the React tree: the full `Shrike` for
 * app/ code, and the `AppServices` view of it for ui/ features.
 */
export function ShrikeProvider({ shrike, children }: { shrike: Shrike; children: ReactNode }) {
  return (
    <ShrikeContext value={shrike}>
      <ShrikeContextProvider value={shrike}>{children}</ShrikeContextProvider>
    </ShrikeContext>
  );
}

export function useShrike(): Shrike {
  const shrike = use(ShrikeContext);
  if (!shrike) throw new Error('useShrike must be used inside <ShrikeProvider>');
  return shrike;
}
